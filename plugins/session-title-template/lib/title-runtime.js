/**
 * Title generation as six named stages behind one entry point.
 *
 * The provider used to be one long closure that read nine outer variables and
 * had seven `return` statements. The behaviour was right, but every new
 * capability had to be threaded through it. Here the decisions are separate
 * functions over plain objects, so a rule can be tested by calling a stage with a
 * literal instead of building a whole plugin context.
 *
 * The stages, in order: resolve the conversation context, decide the plan, select
 * input, resolve routes, compose the prompt, and call with retry.
 *
 * @module session-title-template/title-runtime
 */

import { setTimeout as delay } from 'node:timers/promises';
import { buildSystemPrompt, frameMessages, formatDate, parseModelTitle, selectContextMessages } from './title.js';
import { planTitle } from './title-plan.js';
import { readDelegationLabel } from './delegation.js';
import { resolveRoute, titleCall, describeTitleFailure, isRetryableTitleFailure, isSameRouteRetryableTitleFailure } from './run.js';

/** Failure text shared with the previous implementation. */
const MESSAGES = {
  noMessages: 'session-title-template: at least one human message is required',
  noRoute: 'Cannot regenerate the title: no model route is available',
  badFormat: 'session-title-template: model output did not match the title template',
};

/** Build the options bundle every stage needs for one session date. */
function optionsFor(config, pattern, date) {
  return {
    pattern,
    date,
    template: config.template,
    types: config.types,
    fallbackType: config.fallbackType,
    fallbackTruncation: config.fallbackTruncation,
    cjkSpacing: config.cjkSpacing,
    topicMaxChars: config.topicMaxChars,
  };
}

/**
 * Gather everything the later stages read, from one provider request.
 *
 * @param request - Provider request from the title service.
 * @param deps - Config, pattern and session-title lookups.
 * @returns The resolved context.
 */
export function resolveContext(request, { config, pattern, sessionTitle }) {
  const messages = request.messages ?? [];
  if (!messages.length) throw new Error(MESSAGES.noMessages);
  const date = formatDate(request.session.header?.createdAt, config.timezone, config.dateFormat);
  return {
    messages,
    date,
    options: optionsFor(config, pattern, date),
    current: request.currentTitle ?? sessionTitle.get(request.session),
    sessionId: String(request.session.id),
    isSubagent: request.session.header?.origin === 'subagent',
    delegationLabel: request.session.header?.origin === 'subagent' ? readDelegationLabel(request.session) : undefined,
  };
}

/**
 * Build the "keep the title we have" result.
 *
 * Cited messages that no longer exist are dropped: a keep must reference
 * messages the caller can actually see, and when none survive the first current
 * message stands in so the result is still well-formed.
 *
 * @param context - Resolved conversation context.
 * @returns A provider result that preserves the existing title.
 */
export function keepCurrent(context) {
  const { messages, current } = context;
  const available = new Set(messages.map(message => message.seq));
  const cited = (current.messageSeqs ?? []).filter(seq => available.has(seq));
  const model = current.source.kind === 'provider' ? current.source.model : undefined;
  return {
    title: current.title,
    messageSeqs: cited.length ? cited : [messages[0].seq],
    ...(model ? { model } : {}),
  };
}

/**
 * Ask the planning stage what should happen.
 *
 * @param context - Resolved conversation context.
 * @param flags - Refresh intent and the evaluation watermark.
 * @returns The plan.
 */
export function decidePlan(context, {
  explicitRefresh = false, targeted = false, hint, lastEvaluated, config = {},
} = {}) {
  return planTitle({
    messages: context.messages,
    current: context.current,
    options: context.options,
    explicitRefresh,
    targeted,
    hint,
    lastEvaluated,
    delegationLabel: context.delegationLabel,
    isSubagent: context.isSubagent,
    useDelegationLabel: config.subagentDelegationLabel !== false,
    maxProvisionalRefinements: config.maxProvisionalRefinements,
  });
}

/**
 * Choose the messages that fit the input budget.
 *
 * `selectContextMessages` throws when the budget cannot fit even an empty frame;
 * that is a configuration error the caller must see, so this stage lets it
 * propagate rather than converting it into a silent skip.
 *
 * @param context - Resolved conversation context.
 * @param config - Resolved plugin config.
 * @param plan - Plan from `decidePlan`.
 * @returns `{ selected, messageSeqs }`.
 */
export function selectInput(context, config, plan) {
  const selected = selectContextMessages(context.messages, config.maxInputBytes, undefined, plan.currentTitle);
  return { selected, messageSeqs: selected.map(message => message.seq) };
}

/**
 * Decide which provider/model pairs this call may use.
 *
 * A targeted retitle prefers the configured fallback route so the retitle is not
 * judged by the endpoint that produced the title being replaced.
 *
 * @param config - Resolved plugin config.
 * @param request - Provider request carrying the session route.
 * @param plan - Plan from `decidePlan`.
 * @param ctx - Plugin context for route resolution.
 * @returns `{ routes }` or `{ none: true }`.
 */
export function resolveTargets(config, request, plan, ctx) {
  let route = resolveRoute(config, request, ctx);
  const fallbackRoute = config.backfill.fallbackRoute;
  if (plan.targeted && fallbackRoute) route = fallbackRoute;
  if (!route) return { none: true };
  const routes = [route];
  if (fallbackRoute && (route.provider !== fallbackRoute.provider || route.model !== fallbackRoute.model)) {
    routes.push(fallbackRoute);
  }
  return { routes };
}

/**
 * Compose the system prompt and framed input for one attempt.
 *
 * @param context - Resolved conversation context.
 * @param config - Resolved plugin config.
 * @param plan - Plan from `decidePlan`.
 * @param selected - Messages chosen by `selectInput`.
 * @param guidance - Instruction reader result, when guidance was read.
 * @returns `{ system, input }`.
 */
export function composePrompt(context, config, plan, selected, guidance) {
  const system = buildSystemPrompt({
    ...config,
    template: config.template,
    dateLabel: context.date,
    typeLabel: config.types[0].key,
    topicLabel: config.language === 'en' ? 'Topic' : '主题',
    isRefining: context.messages.length > 1,
    hint: plan.hint,
    namingGuidance: guidance,
    currentTitle: plan.currentTitle,
  });
  return { system, input: frameMessages(selected, plan.currentTitle) };
}

/**
 * Call the model, retrying the whole route set with backoff.
 *
 * One round walks every configured route, so a healthy fallback wins
 * immediately instead of waiting for the primary to fail out. Deterministic
 * failures (an over-budget input) stop at once because repeating them cannot
 * change the outcome. A reply the parser rejects is not asked again from the
 * same route in the same round — the same model tends to repeat the same
 * malformed line — but the other configured routes still get their turn.
 *
 * @param options - Routes, prompt, context, config and collaborators.
 * @returns `{ title, messageSeqs, model }` or `{ keep: true }`.
 */
export async function callWithRetry({
  routes, prompt, messageSeqs, context, config, request, signal, deps,
}) {
  const { ctx, state, roleProbe, providerId } = deps;
  // Observation only: a probe never delays or fails a title.
  for (const candidate of routes) void roleProbe.ensure(candidate, request).catch(() => {});
  let failure;
  let abandoned = false;
  const skipRoutes = new Set();
  for (let attempt = 1; attempt <= config.retryAttempts && !abandoned; attempt += 1) {
    for (const target of routes) {
      if (skipRoutes.has(target)) continue;
      try {
        const text = await titleCall({
          ctx, config, request, route: target, system: prompt.system, input: prompt.input, messageSeqs, signal, providerId,
        });
        signal.throwIfAborted();
        const parsed = parseModelTitle(text, context.options);
        if (!parsed) throw new Error(MESSAGES.badFormat);
        if (context.current?.source.kind === 'provider' && parsed.title === context.current.title) {
          return { keep: true };
        }
        return { title: parsed.title, model: { provider: target.provider, model: target.model } };
      } catch (error) {
        signal.throwIfAborted();
        failure = error;
        // Keep the cause: the category separates a route failure from an
        // unusable reply, and it is what the status view reports.
        const detail = describeTitleFailure(error, attempt, config.retryAttempts);
        const routeLabel = `${target.provider}/${target.model}`;
        state.note(`title-call-failed route=${routeLabel} ${detail.text}`);
        state.record({ kind: 'title-call-failed', route: routeLabel, attempt, category: detail.category, sessionId: context.sessionId });
        if (!isRetryableTitleFailure(error)) { abandoned = true; break; }
        if (!isSameRouteRetryableTitleFailure(error)) skipRoutes.add(target);
      }
    }
    if (abandoned || attempt >= config.retryAttempts) break;
    // A fresh round gives a skipped route a new chance only when the whole set
    // failed; if every route was skipped, there is nothing left to try.
    if (skipRoutes.size >= routes.length) break;
    try {
      await delay(Math.min(config.retryDelayMs * 2 ** (attempt - 1), 10_000), undefined, { signal });
    } catch {
      signal.throwIfAborted();
    }
  }
  throw failure;
}

/** Maximum number of per-session entries kept in process-local maps. */
const SESSION_BOOKKEEPING_LIMIT = 500;

/** Store one bounded LRU entry so long-running hosts never grow maps without bound. */
function rememberBounded(map, key, value, limit = SESSION_BOOKKEEPING_LIMIT) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * Build the provider used by the session-title service.
 *
 * @param options - Config, collaborators and the plugin's lifetime signal.
 * @returns A provider object with one `generate` entry point.
 */
export function createTitleRuntime({ config, pattern, ctx, state, signal: lifetime, roleProbe, readInstructions, providerId, bookkeeping }) {
  const { forcedRefreshes, activeRetitles, lastEvaluations, lastSuccesses = new Map() } = bookkeeping;
  const deps = { ctx, state, roleProbe, providerId };

  return {
    async generate(request) {
      const signal = AbortSignal.any([lifetime, ...(request.signal ? [request.signal] : [])]);
      signal.throwIfAborted();

      const context = resolveContext(request, { config, pattern, sessionTitle: ctx.sessionTitle });
      const explicitRefresh = forcedRefreshes.has(context.sessionId);
      const targeted = activeRetitles.has(context.sessionId);
      const plan = decidePlan(context, {
        explicitRefresh,
        targeted,
        hint: activeRetitles.get(context.sessionId),
        lastEvaluated: lastEvaluations.get(context.sessionId),
        config,
      });
      if (!plan.refresh) return keepCurrent(context);

      // A delegation label already names the session; the model is only needed
      // to refine it, so the deterministic title is emitted without a request.
      if (plan.delegationTitle !== undefined && !plan.forced && context.current?.source.kind !== 'provider') {
        return { title: plan.delegationTitle, messageSeqs: [context.messages[0].seq] };
      }

      const input = selectInput(context, config, plan);

      const targets = resolveTargets(config, request, plan, ctx);
      if (targets.none) {
        if (explicitRefresh) throw new Error(MESSAGES.noRoute);
        if (context.current && plan.canonical) return keepCurrent(context);
        return { title: plan.fallback, messageSeqs: input.messageSeqs };
      }

      const guidance = await readGuidance({ readInstructions, config, ctx, signal, request, state });
      signal.throwIfAborted();
      const prompt = composePrompt(context, config, plan, input.selected, guidance);

      const outcome = await callWithRetry({
        routes: targets.routes, prompt, messageSeqs: input.messageSeqs, context, config, request, signal, deps,
      });
      // Record the watermark and success timestamp only after the model actually
      // answered: a failed call must stay pending, so the next human message
      // retries it instead of being skipped as "already evaluated".
      recordEvaluation(context, lastEvaluations);
      rememberBounded(lastSuccesses, context.sessionId, Date.now());
      if (outcome.keep) return keepCurrent(context);
      return { title: outcome.title, messageSeqs: input.messageSeqs, model: outcome.model };
    },
  };
}

/** Remember how far the last real model evaluation saw. */
function recordEvaluation(context, lastEvaluations) {
  const lastSeq = context.messages.reduce(
    (max, message) => (Number.isSafeInteger(message.seq) && message.seq > max ? message.seq : max), 0);
  rememberBounded(lastEvaluations, context.sessionId, { seq: lastSeq, count: context.messages.length });
}

/**
 * Read applicable AGENTS naming excerpts, if guidance is enabled.
 *
 * @param deps - Reader, config, plugin context, cancellation, request and log sink.
 * @returns The reader result, or undefined when guidance is disabled.
 */
async function readGuidance({ readInstructions, config, ctx, signal, request, state }) {
  if (!readInstructions) return undefined;
  const cwd = ctx.get?.('workingDirectory')?.get?.(request.session) ?? request.session.header?.cwd;
  const guidance = await readInstructions({ cwd, signal, maxBytes: config.agentsInstructions.maxBytes });
  // A missing or unreadable file must not fail naming; say so in the log and go on.
  if (guidance?.unavailable) state.note('agents-instructions-unavailable');
  return guidance;
}
