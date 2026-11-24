/** Structured titles and current-session metadata tools for DeepSeek Harness. */
import { resolveConfig } from './lib/config.js';
import { createStateStore, stateDirectory } from './lib/state.js';
import { createInstructionReader } from './lib/instructions.js';
import { applyBackfill, backfillTitles, planBackfill } from './lib/backfill.js';
import { compileTitlePattern, formatDate } from './lib/title.js';
import { createTitleRuntime } from './lib/title-runtime.js';
import { describeTitleState } from './lib/title-state.js';
import { resolveRoute } from './lib/run.js';
import { createRoleProbe } from './lib/role-probe.js';
import { registerCoordination } from './lib/coordination.js';
import { titleStateProjectionDefinition } from './lib/projection.js';
import { registerTitleCommands } from './lib/commands.js';

export const name = 'session-title-template';
export const inject = ['sessionTitle', 'llm', 'sessions', 'sessionProjections'];

export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const lifetime = new AbortController();
  const profileDirectory = ctx.get?.('profileContext')?.dir;
  const state = createStateStore({ directory: stateDirectory({ ...process.env, ...(profileDirectory ? { DSH_PROFILE_DIR: profileDirectory } : {}) }) });
  const pattern = compileTitlePattern(config.template, config.types.map(type => type.key));
  const activeRetitles = new Map();
  // Per-session watermark of the last model evaluation that actually ran.
  const lastEvaluations = new Map();
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
  // One callback answers the whole status question, so the tool stays read-only.
  const describeSession = async (session) => {
    const date = formatDate(session.header?.createdAt, config.timezone, config.dateFormat);
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
      sessionId: String(session.id),
    });
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
    bookkeeping: { forcedRefreshes, activeRetitles, lastEvaluations },
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

  // The Client reads title state from this projection, which the Harness drives
  // and ships to Session list rows; the plugin registers no Remote method.
  // Registration may resolve late, so a failure here must not take the whole
  // fiber down: a missing status icon is far better than no titles at all.
  void ctx.inject?.(['sessionProjections'], async (projectionCtx) => {
    if (lifetime.signal.aborted) return;
    try {
      await projectionCtx.sessionProjections.register(titleStateProjectionDefinition);
    } catch {
      state.note('title-state-projection-failed');
    }
  });
  // `/title` is the in-session entry point and the Client's route to the Host.
  void ctx.inject?.(['commands'], (commandCtx) => {
    if (lifetime.signal.aborted) return;
    registerTitleCommands(commandCtx, {
      state,
      describe: describeSession,
      refresh: async (session, signal) => {
        const id = String(session.id);
        forcedRefreshes.add(id);
        try { return await ctx.sessionTitle.refresh(session, signal); }
        finally { forcedRefreshes.delete(id); }
      },
    });
  });

  // Both delayed and active maintenance are owned by this plugin activation.
  ctx.effect(() => async () => {
    // Drain detached probes first: aborting the lifetime would cancel them before
    // their verdict reaches the diagnostic log.
    await roleProbe.drained();
    lifetime.abort(new Error('session-title-template: plugin disposed'));
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
