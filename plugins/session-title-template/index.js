/** Structured titles and current-session metadata tools for DeepSeek Harness. */
import { resolveConfig } from './lib/config.js';
import { createStateStore, stateDirectory } from './lib/state.js';
import { createInstructionReader } from './lib/instructions.js';
import { backfillTitles } from './lib/backfill.js';
import { buildFallbackTitle, buildSystemPrompt, compileTitlePattern, formatDate, frameMessages, isFormattedTitle, isSettledTitle, parseModelTitle, selectContextMessages } from './lib/title.js';
import { decideTitleRefresh } from './lib/refresh-policy.js';
import { resolveRoute, titleCall } from './lib/run.js';
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
  await registerCoordination(ctx, { config, state, forcedRefreshes, lifetime, providerId: name });
  const titleOptions = (date) => ({ pattern, date, template: config.template, types: config.types, cjkSpacing: config.cjkSpacing, topicMaxChars: config.topicMaxChars });
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
      const explicitRefresh = forcedRefreshes.has(String(request.session.id));
      const targeted = activeRetitles.has(String(request.session.id));
      const forced = targeted || explicitRefresh;
      const hint = activeRetitles.get(String(request.session.id))
        ?? (explicitRefresh ? 'Explicit refresh: reconsider the session topic; do not keep a poor title merely because its format is valid.' : undefined);
      const fallback = buildFallbackTitle({ date, template: config.template, fallbackType: config.fallbackType, sourceText: messages[0].text, cjkSpacing: config.cjkSpacing, topicMaxChars: config.topicMaxChars });
      // A deterministic first-message truncation has never demonstrated a useful
      // summary. Recognize legacy provider-labelled fallbacks as well, even when
      // old versions attached model metadata to them.
      const needsRecovery = current?.title === fallback
        || (current?.source.kind === 'provider' && !current.source.model
          && isFormattedTitle(current.title, options) && fallback.startsWith(current.title));
      const keepCurrent = () => {
        const available = new Set(messages.map(message => message.seq));
        const cited = (current.messageSeqs ?? []).filter(seq => available.has(seq));
        const model = current.source.kind === 'provider' ? current.source.model : undefined;
        return { title: current.title, messageSeqs: cited.length ? cited : [messages[0].seq], ...(model ? { model } : {}) };
      };
      const canonical = current ? isFormattedTitle(current.title, options) : false;
      const sessionId = String(request.session.id);
      // Adaptive evaluation replaces the old unconditional settled-title return:
      // a settled title is kept only while the cheap local policy finds no reason
      // to ask the model again. The decision is anchored to the last evaluation
      // recorded in memory, so the same messages are not evaluated repeatedly.
      const decision = decideTitleRefresh({
        messages,
        current,
        canonical,
        provisional: canonical && !isSettledTitle(current.title, options),
        forced,
        recovery: needsRecovery,
        lastEvaluated: lastEvaluations.get(sessionId),
      });
      if (!decision.refresh) return keepCurrent();
      const currentTitle = current ? { title: current.title, canonical } : undefined;
      const selected = selectContextMessages(messages, config.maxInputBytes, undefined, currentTitle);
      if (!selected.length) throw new Error('session-title-template: no input fits the configured byte budget');
      const messageSeqs = selected.map(message => message.seq);
      let route = resolveRoute(config, request, ctx);
      const fallbackRoute = config.backfill.fallbackRoute;
      if (targeted && fallbackRoute) route = fallbackRoute;
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
      const routes = [route];
      if (fallbackRoute && (route.provider !== fallbackRoute.provider || route.model !== fallbackRoute.model)) routes.push(fallbackRoute);
      let failure;
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
          state.note('title-call-failed');
        }
      }
      throw failure;
    },
  });

  // Both delayed and active maintenance are owned by this plugin activation.
  ctx.effect(() => async () => {
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
