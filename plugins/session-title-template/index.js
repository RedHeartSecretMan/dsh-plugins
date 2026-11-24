/** Structured titles and current-session metadata tools for DeepSeek Harness. */
import { setTimeout as delay } from 'node:timers/promises';
import { resolveConfig } from './lib/config.js';
import { createStateStore, stateDirectory } from './lib/state.js';
import { createInstructionReader } from './lib/instructions.js';
import { backfillTitles } from './lib/backfill.js';
import { buildSystemPrompt, compileTitlePattern, formatDate, frameMessages, parseModelTitle, selectContextMessages } from './lib/title.js';
import { planTitle } from './lib/title-plan.js';
import { readDelegationLabel } from './lib/delegation.js';
import { describeTitleState } from './lib/title-state.js';
import { resolveRoute, titleCall, describeTitleFailure, isRetryableTitleFailure } from './lib/run.js';
import { createRoleProbe } from './lib/role-probe.js';
import { registerCoordination } from './lib/coordination.js';

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
    onVerdict: verdict => state.record({ kind: 'role-probe', route: `${verdict.provider}/${verdict.model}`, verdict: verdict.verdict }),
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
      probe: route === undefined ? undefined : roleProbe.detail(route),
      records: await state.recentRecords(),
    });
  };
  await registerCoordination(ctx, { config, state, forcedRefreshes, lifetime, providerId: name, describe: describeSession });
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
  let backfillRun;
  let timer;

  ctx.sessionTitle.register({
    id: name,
    automatic: 'all-prompts',
    async generate(request) {
      const signal = AbortSignal.any([lifetime.signal, ...(request.signal ? [request.signal] : [])]);
      signal.throwIfAborted();
      const messages = request.messages ?? [];
      if (!messages.length) throw new Error('session-title-template: at least one human message is required');
      const date = formatDate(request.session.header?.createdAt, config.timezone, config.dateFormat);
      const options = titleOptions(date);
      const current = request.currentTitle ?? ctx.sessionTitle.get(request.session);
      // Native provider requests do not carry a refresh/automatic discriminator.
      // Our explicit refresh tool and targeted backfill supply an unambiguous intent.
      const sessionId = String(request.session.id);
      const explicitRefresh = forcedRefreshes.has(sessionId);
      const targeted = activeRetitles.has(sessionId);
      const keepCurrent = () => {
        const available = new Set(messages.map(message => message.seq));
        const cited = (current.messageSeqs ?? []).filter(seq => available.has(seq));
        const model = current.source.kind === 'provider' ? current.source.model : undefined;
        return { title: current.title, messageSeqs: cited.length ? cited : [messages[0].seq], ...(model ? { model } : {}) };
      };
      // Planning is a pure decision over the snapshot: it owns the refresh policy,
      // the fallback title and the canonical check, so this provider only wires it.
      const delegationLabel = readDelegationLabel(request.session);
      const plan = planTitle({
        messages,
        current,
        options,
        explicitRefresh,
        targeted,
        hint: activeRetitles.get(sessionId),
        lastEvaluated: lastEvaluations.get(sessionId),
        delegationLabel,
        isSubagent: delegationLabel !== undefined,
      });
      if (!plan.refresh) return keepCurrent();
      const { fallback, currentTitle, hint, canonical, targeted: targetedRetitle, delegationTitle } = plan;
      // A delegation label already names the session; the model is only needed for
      // refinement, so the deterministic title is emitted without a request.
      if (delegationTitle !== undefined
        && !plan.forced
        && current?.source.kind !== 'provider') {
        return {
          title: delegationTitle,
          messageSeqs: [messages[0].seq],
        };
      }
      const selected = selectContextMessages(messages, config.maxInputBytes, undefined, currentTitle);
      if (!selected.length) throw new Error('session-title-template: no input fits the configured byte budget');
      const messageSeqs = selected.map(message => message.seq);
      let route = resolveRoute(config, request, ctx);
      const fallbackRoute = config.backfill.fallbackRoute;
      if (targetedRetitle && fallbackRoute) route = fallbackRoute;
      if (!route) {
        if (explicitRefresh) throw new Error('Cannot regenerate the title: no model route is available');
        if (current && canonical) return keepCurrent();
        return { title: fallback, messageSeqs };
      }
      const cwd = readInstructions ? (ctx.get?.('workingDirectory')?.get?.(request.session) ?? request.session.header?.cwd) : undefined;
      const namingGuidance = readInstructions ? await readInstructions({ cwd, signal, maxBytes: config.agentsInstructions.maxBytes }) : undefined;
      signal.throwIfAborted();
      if (namingGuidance?.unavailable) state.note('agents-instructions-unavailable');
      const system = buildSystemPrompt({ ...config, template: config.template, dateLabel: date, typeLabel: config.types[0].key, topicLabel: config.language === 'en' ? 'Topic' : '主题', isRefining: messages.length > 1, hint, namingGuidance, currentTitle });
      const input = frameMessages(selected, currentTitle);
      // Observe whether this endpoint can actually receive the instruction block.
      // The run is detached: it must never delay or fail title generation.
      void roleProbe.probe(route, request).catch(() => {});
      const routes = [route];
      if (fallbackRoute && (route.provider !== fallbackRoute.provider || route.model !== fallbackRoute.model)) routes.push(fallbackRoute);
      let failure;
      let abandoned = false;
      // One round tries every configured route once, so a healthy fallback still
      // wins immediately; later rounds retry the whole set with backoff.
      for (let attempt = 1; attempt <= config.retryAttempts && !abandoned; attempt += 1) {
        for (const target of routes) {
          try {
            const text = await titleCall({
              ctx, config, request, route: target, system, input, messageSeqs, signal, providerId: name,
            });
            signal.throwIfAborted();
            const parsed = parseModelTitle(text, options);
            if (!parsed) throw new Error('session-title-template: model output did not match the title template');
            // Record what was actually evaluated, even when the model keeps the
            // title: later prompts only need to consider newer messages.
            const lastSeq = messages.reduce((max, message) => (Number.isSafeInteger(message.seq) && message.seq > max ? message.seq : max), 0);
            lastEvaluations.set(sessionId, { seq: lastSeq, count: messages.length });
            // An unchanged provider title is a deliberate keep, not a rewrite: the
            // previous provenance and cited messages remain the source of truth.
            if (current?.source.kind === 'provider' && parsed.title === current.title) return keepCurrent();
            return { title: parsed.title, messageSeqs, model: { provider: target.provider, model: target.model } };
          } catch (error) {
            signal.throwIfAborted();
            failure = error;
            // The label alone cannot separate a route failure from an unusable
            // model reply; keep the cause so the next incident is diagnosable.
            const detail = describeTitleFailure(error, attempt, config.retryAttempts);
            const routeLabel = `${target.provider}/${target.model}`;
            state.note(`title-call-failed route=${routeLabel} ${detail.text}`);
            // Record the fields directly: no caller has to parse them back out.
            state.record({ kind: 'title-call-failed', route: routeLabel, attempt, category: detail.category });
            if (!isRetryableTitleFailure(error)) { abandoned = true; break; }
          }
        }
        if (abandoned || attempt >= config.retryAttempts) break;
        try {
          await delay(Math.min(config.retryDelayMs * 2 ** (attempt - 1), 10_000), undefined, { signal });
        } catch {
          signal.throwIfAborted();
        }
      }
      throw failure;
    },
  });

  // Both delayed and active maintenance are owned by this plugin activation.
  ctx.effect(() => async () => {
    // Drain detached probes first: aborting the lifetime would cancel them before
    // their verdict reaches the diagnostic log.
    await roleProbe.idle();
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
