/** Structured titles and current-session metadata tools for DeepSeek Harness. */
import { resolveConfig } from './lib/config.js';
import { createStateStore, stateDirectory } from './lib/state.js';
import { createInstructionReader } from './lib/instructions.js';
import { applyBackfill, backfillTitles, planBackfill } from './lib/backfill.js';
import { compileTitlePattern } from './lib/title.js';
import { createTitleRuntime } from './lib/title-runtime.js';
import { describeTitleState } from './lib/title-state.js';
import { resolveRoute } from './lib/run.js';
import { createRoleProbe } from './lib/role-probe.js';
import { registerCoordination } from './lib/coordination.js';
import { titleStateProjectionDefinition } from './lib/projection.js';
import { registerTitleCommands } from './lib/commands.js';
import { registerStatusRoute } from './lib/status-route.js';
import { registerSettingsRoute } from './lib/settings-route.js';

export const name = 'session-title-template';
export const inject = ['sessionTitle', 'llm', 'sessions', 'sessionProjections'];

/** Maximum grace time before aborting in-flight role probes during plugin dispose. */
const DISPOSE_PROBE_GRACE_MS = 1500;

export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const lifetime = new AbortController();
  const profileDirectory = ctx.get?.('profileContext')?.dir;
  const state = createStateStore({ directory: stateDirectory({ ...process.env, ...(profileDirectory ? { DSH_PROFILE_DIR: profileDirectory } : {}) }) });
  const pattern = compileTitlePattern(config.template, config.types.map(type => type.key));
  const activeRetitles = new Map();
  // Bounded per-session bookkeeping for evaluation watermarks and last model success.
  const lastEvaluations = new Map();
  const lastSuccesses = new Map();
  const readInstructions = config.agentsInstructions.enabled
    ? createInstructionReader({ onDiagnostic: reason => state.note(`agents-instructions-${reason}`) }) : undefined;
  const forcedRefreshes = new Set();
  const roleProbe = createRoleProbe({
    ctx,
    config,
    note: line => state.note(line),
    onVerdict: verdict => state.record({
      kind: 'role-probe',
      route: `${verdict.provider}/${verdict.model}`,
      verdict: verdict.verdict,
      ...(verdict.sessionId === undefined ? {} : { sessionId: verdict.sessionId }),
    }),
    signal: lifetime.signal,
  });

  // One shared explicit-refresh helper used by tools, `/title`, and the sidebar route.
  const refreshSession = async (session, signal) => {
    const id = String(session.id);
    forcedRefreshes.add(id);
    try { return await ctx.sessionTitle.refresh(session, signal); }
    finally { forcedRefreshes.delete(id); }
  };

  // One callback answers the whole status question for a live session, read-only.
  const describeSession = async (session) => {
    const id = String(session.id);
    const guidance = readInstructions
      ? await readInstructions({ cwd: ctx.get?.('workingDirectory')?.get?.(session) ?? session.header?.cwd, maxBytes: config.agentsInstructions.maxBytes })
      : undefined;
    const route = resolveRoute(config, { session }, ctx);
    return describeTitleState({
      config,
      current: ctx.sessionTitle.get(session),
      guidance,
      probe: route === undefined ? undefined : roleProbe.verdictOf(route),
      records: await state.recentRecords(),
      sessionId: id,
      lastSuccessAt: lastSuccesses.get(id),
    });
  };

  // Read-only status fallback for unopened (cold) sessions via sessionQuery,
  // avoiding agent resumption while still surfacing persisted title and rules.
  const describeColdSession = async (sessionId) => {
    const query = ctx.get?.('sessionQuery');
    if (typeof query?.readSession !== 'function') return { unavailable: true };
    let observed;
    try {
      observed = await query.readSession(sessionId);
    } catch {
      return { notFound: true };
    }
    if (!observed || !Array.isArray(observed.events)) return { notFound: true };
    const titleEvent = observed.events.findLast(event => event?.type === 'session/title');
    const current = titleEvent?.data
      ? {
        ...titleEvent.data,
        ...(Number.isFinite(titleEvent.time) ? { updatedAt: titleEvent.time } : {}),
      }
      : undefined;
    const workspaceRootEvent = observed.events.findLast(event => event?.type === 'workspace-root/change');
    const cwd = typeof workspaceRootEvent?.data?.cwd === 'string'
      ? workspaceRootEvent.data.cwd
      : observed.session?.cwd;
    const guidance = readInstructions
      ? await readInstructions({ cwd, maxBytes: config.agentsInstructions.maxBytes })
      : undefined;
    const headerConfig = observed.events.findLast(event => event?.type === 'request/header')?.data?.config;
    const isColdSubagent = observed.session?.origin === 'subagent';
    const route = isColdSubagent && config.subagentRoute !== undefined
      ? config.subagentRoute
      : config.provider !== undefined
        ? { provider: config.provider, model: config.model }
        : (headerConfig?.provider && headerConfig?.model
          ? { provider: headerConfig.provider, model: headerConfig.model }
          : config.backfill.fallbackRoute);
    const id = String(sessionId);
    return {
      snapshot: describeTitleState({
        config,
        current,
        guidance,
        probe: route === undefined ? undefined : roleProbe.verdictOf(route),
        records: await state.recentRecords(),
        sessionId: id,
        lastSuccessAt: lastSuccesses.get(id),
      }),
    };
  };

  // Every field planning needs travels together: the fallback type builds the
  // pre-model title, and parse/format checks need pattern and vocabulary.
  const titleOptions = (date) => ({
    pattern,
    date,
    template: config.template,
    types: config.types,
    fallbackType: config.fallbackType,
    cjkSpacing: config.cjkSpacing,
    topicMaxChars: config.topicMaxChars,
  });
  // Six named stages behind one entry point; see lib/title-runtime.js.
  const runtime = createTitleRuntime({
    config,
    pattern,
    ctx,
    state,
    signal: lifetime.signal,
    roleProbe,
    readInstructions,
    providerId: name,
    bookkeeping: { forcedRefreshes, activeRetitles, lastEvaluations, lastSuccesses },
  });
  await registerCoordination(ctx, {
    config,
    state,
    forcedRefreshes,
    lifetime,
    providerId: name,
    describe: describeSession,
    backfill: {
      plan: () => planBackfill(ctx, { config, state, titleOptions }),
      apply: async ids => applyBackfill(ctx, { config, state, titleOptions, activeRetitles }, ids),
    },
  });
  let backfillRun;
  let timer;

  ctx.sessionTitle.register({
    id: name,
    automatic: 'all-prompts',
    generate: runtime.generate,
  });

  // `sessionProjections` is declared in top-level `inject`, so register and
  // await directly here so initial session-list reads see `sessionTitleState`.
  // A failure still degrades gracefully: a missing status icon is far better
  // than losing automatic titles.
  if (!lifetime.signal.aborted && typeof ctx.sessionProjections?.register === 'function') {
    try {
      await ctx.sessionProjections.register(titleStateProjectionDefinition);
    } catch {
      state.note('title-state-projection-failed');
    }
  }
  // `/title` is the in-session entry point and fallback command path.
  void ctx.inject?.(['commands'], (commandCtx) => {
    if (lifetime.signal.aborted) return;
    registerTitleCommands(commandCtx, {
      state,
      describe: describeSession,
      refresh: refreshSession,
    });
  });

  // Owner-only HTTP routes so the Client sidebar can inspect status (live or
  // cold) and trigger title refreshes without appending `/title` command cards
  // into the active conversation transcript.
  void ctx.inject?.(['webServer'], (webCtx) => {
    if (lifetime.signal.aborted) return;
    registerStatusRoute(webCtx, {
      describe: describeSession,
      describeCold: describeColdSession,
      refresh: refreshSession,
      state,
    });
    // Quick settings and developer YAML save through the Harness config editor,
    // which keeps the rest of the profile patch (comments, other plugins, `!!js`
    // rows) intact.
    registerSettingsRoute(webCtx, {
      config,
      rawConfig,
      llm: ctx.llm,
      state,
      getEditor: () => {
        const editor = ctx.get?.('configEditor');
        const entry = ctx.fiber?.entry;
        // Only rows owned by the profile's root Include are addressable; a row
        // inside a nested Include is read-only here and the form says so.
        const addressable = editor !== undefined && entry !== undefined
          && (typeof editor.entries !== 'function' || editor.entries().includes(entry));
        return addressable ? { editor, entry } : {};
      },
    });
  });

  // Both delayed and active maintenance are owned by this plugin activation.
  ctx.effect(() => async () => {
    // Give fast in-flight probes a bounded grace window to log their verdict,
    // then abort the lifetime so a hung endpoint cannot stall plugin unload.
    const graceMs = Math.min(config.timeoutMs, DISPOSE_PROBE_GRACE_MS);
    let graceTimer;
    await Promise.race([
      roleProbe.drained(),
      new Promise((resolve) => {
        graceTimer = setTimeout(resolve, graceMs);
        graceTimer.unref?.();
      }),
    ]);
    clearTimeout(graceTimer);
    lifetime.abort(new Error('session-title-template: plugin disposed'));
    await roleProbe.drained().catch(() => {});
    clearTimeout(timer);
    await backfillRun;
    await state.idle();
  });
  if (config.backfill.enabled) {
    timer = setTimeout(() => {
      if (lifetime.signal.aborted) return;
      backfillRun = backfillTitles(ctx, { config, state, signal: lifetime.signal, titleOptions, activeRetitles })
        .catch(() => { if (!lifetime.signal.aborted) state.note('backfill-failed'); });
    }, 2500);
    timer.unref?.();
  }
}
