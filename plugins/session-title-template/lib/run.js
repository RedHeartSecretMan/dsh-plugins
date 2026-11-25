/** Resolve the title route and execute one structured title request. */
import { randomUUID } from 'node:crypto';
import { collectStreamText } from './stream-text.js';

/** Pick the route used for a title request without switching the main agent route. */
export function resolveRoute(config, request, ctx) {
  if (config.provider !== undefined) return { provider: config.provider, model: config.model };
  if (request.route?.provider && request.route.model) return request.route;
  const header = request.session.requestHeader?.()?.config;
  if (header?.provider && header.model) return { provider: header.provider, model: header.model };
  try {
    // `stateOf(session, key)` is deprecated on current Harness and logs one
    // warning per key on every Host; the snapshot face is the supported read.
    const projection = typeof ctx.sessionProjections?.snapshot === 'function'
      ? ctx.sessionProjections.snapshot(request.session, ['modelSelection'])?.values?.modelSelection
      : ctx.sessionProjections?.stateOf?.(request.session, 'modelSelection');
    const selection = projection?.pending ?? projection?.lastUsed;
    if (selection?.provider && selection.model) return { provider: selection.provider, model: selection.model };
  } catch {
    // The optional modelSelection unit is not registered in every profile.
  }
  return config.backfill.fallbackRoute;
}

/** Read only text blocks, and require a successful terminal outcome. */
export async function titleCall({
  ctx, config, request, route, system, input, messageSeqs, signal, providerId,
}) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('session-title-template: title request timed out')), config.timeoutMs);
  timer.unref?.();
  const combined = AbortSignal.any([signal, timeout.signal]);
  try {
    combined.throwIfAborted();
    if (Buffer.byteLength(input, 'utf8') > config.maxInputBytes) throw new Error('session-title-template: input byte budget exceeded');
    const call = await ctx.llm.prepareCall({ ...route, maxTokens: config.maxOutputTokens }, combined, (controls, model) => {
      const effort = model.reasoning?.efforts?.[0]?.id;
      return { ...controls, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
    });
    // The session-format v4 restore validator requires this exact source kind on the
    // recorded request message; a provider-named kind makes the stored log unreadable.
    const messages = [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: input }], source: { kind: 'dsh-session-title-llm' } }];
    const options = { ...call.config, messages, system, sessionId: request.session.id, purpose: 'session-title', signal: combined };
    combined.throwIfAborted();
    // Use the built-in event type and payload, so auxiliary requests remain replayable.
    request.session.append('session/title-llm-request', {
      titleProvider: providerId, messageSeqs, route, system, messages, maxTokens: config.maxOutputTokens,
      ...(call.config.reasoningEffort === undefined ? {} : { reasoningEffort: call.config.reasoningEffort }),
    });
    return await collectStreamText(call.stream(options), combined, { prefix: 'session-title-template' });
  } finally { clearTimeout(timer); }
}

/**
 * Classify one failure without exposing provider text or credential-bearing detail.
 *
 * Error messages can contain prompt fragments, response bodies or credentials, so
 * diagnostics keep the route, attempt, provider code and a stable local category.
 * The category is returned as a field: callers record it as data instead of
 * parsing it back out of a formatted line.
 *
 * @param error - rejection or thrown value from a title attempt.
 * @param attempt - 1-based attempt number that failed.
 * @param attempts - configured attempt budget.
 * @returns Attempt, code, category and the bounded display text for the log.
 */
export function describeTitleFailure(error, attempt, attempts) {
  const rawCode = typeof error?.code === 'string' && error.code !== ''
    ? error.code : String(error?.name ?? 'Error');
  const code = rawCode.replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 64) || 'Error';
  const message = String(error?.message ?? '');
  // The Harness timeout helper and the local deadline both carry a code ending in
  // TIMEOUT; tool-call rejections carry TITLE_TOOL_OUTPUT; a truncated reply
  // (max-tokens) is an output the configured budget could not finish.
  const category = /input byte budget exceeded|no input fits the configured byte budget/u.test(message)
    ? 'input-budget'
    : /model output did not match the title template/u.test(message)
      ? 'invalid-title-format'
      : /TITLE_TOOL_OUTPUT/u.test(code) || /tool call|tool-calls/u.test(message)
        ? 'tool-output'
        : /TIMEOUT/u.test(code) || /timed out|timeout/u.test(message)
          ? 'timeout'
          : /terminal finish \(max-tokens\)/u.test(message)
            ? 'output-truncated'
            : /terminal finish|stream failed|missing/u.test(message)
              ? 'stream-failure'
              : 'provider-failure';
  return { attempt, attempts, code, category, text: `attempt ${attempt}/${attempts} ${code}: ${category}` };
}

/**
 * Report whether another attempt on the same route can plausibly succeed.
 *
 * Budget and selection failures repeat deterministically, so retrying them only
 * delays the fallback and spends the same work twice.
 *
 * @param error - rejection or thrown value from a title attempt.
 * @returns `true` when the caller should attempt again.
 */
export function isRetryableTitleFailure(error) {
  const message = String(error?.message ?? '');
  return !/input byte budget exceeded|no input fits the configured byte budget/u.test(message);
}

/**
 * Report whether the same route should be asked again after one unusable reply.
 *
 * A reply the parser rejects, or one the output budget truncated, is a property
 * of the request on that model: asking the identical prompt again usually
 * yields the identical result. The next configured route still gets its
 * chance, and a later round may retry.
 *
 * @param error - rejection or thrown value from a title attempt.
 * @returns `true` when this route deserves an immediate second request.
 */
export function isSameRouteRetryableTitleFailure(error) {
  if (!isRetryableTitleFailure(error)) return false;
  const message = String(error?.message ?? '');
  return !/model output did not match the title template|terminal finish \(max-tokens\)/u.test(message);
}
