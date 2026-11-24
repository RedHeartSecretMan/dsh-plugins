/** Resolve the title route and execute one structured title request. */
import { randomUUID } from 'node:crypto';

/** Pick the route used for a title request without switching the main agent route. */
export function resolveRoute(config, request, ctx) {
  if (config.provider !== undefined) return { provider: config.provider, model: config.model };
  if (request.route?.provider && request.route.model) return request.route;
  const header = request.session.requestHeader?.()?.config;
  if (header?.provider && header.model) return { provider: header.provider, model: header.model };
  try {
    const selection = ctx.sessionProjections.stateOf(request.session, 'modelSelection')?.lastUsed;
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
    const blocks = new Map();
    let finish;
    for await (const chunk of call.stream(options)) {
      combined.throwIfAborted();
      const index = chunk.index ?? 0;
      if (chunk.type === 'finish') { finish = chunk.reason; continue; }
      if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')) {
        throw new Error('session-title-template: title response must not contain tool calls');
      }
      if (chunk.type === 'block-end') {
        if (chunk.block.type === 'tool-call') throw new Error('session-title-template: title response contains a tool call');
        if (!blocks.get(index)?.closed) blocks.set(index, { text: chunk.block.type === 'text' ? chunk.block.text : '', closed: true });
      } else if (chunk.type === 'text-delta' && !blocks.get(index)?.closed) {
        blocks.set(index, { text: (blocks.get(index)?.text ?? '') + chunk.text, closed: false });
      }
    }
    combined.throwIfAborted();
    if (finish?.kind !== 'stop') {
      const error = new Error(`session-title-template: unsuccessful terminal finish (${finish?.kind ?? 'missing'})`);
      error.code = finish?.failure?.code ?? 'TITLE_STREAM_FAILED';
      throw error;
    }
    return [...blocks.values()].map(block => block.text).join(' ');
  } finally { clearTimeout(timer); }
}

/**
 * Classify one failure without writing provider text or model output to logs.
 *
 * Error messages can contain prompt fragments, response bodies or credentials.
 * Diagnostics keep the route, attempt, provider code and a stable local category.
 *
 * @param error - rejection or thrown value from a title attempt.
 * @param attempt - 1-based attempt number that failed.
 * @param attempts - configured attempt budget.
 * @returns Text safe to append after the `title-call-failed` label.
 */
export function describeTitleFailure(error, attempt, attempts) {
  const rawCode = typeof error?.code === 'string' && error.code !== ''
    ? error.code : String(error?.name ?? 'Error');
  const code = rawCode.replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 64) || 'Error';
  const message = String(error?.message ?? '');
  const category = /input byte budget exceeded|no input fits the configured byte budget/u.test(message)
    ? 'input-budget'
    : /model output did not match the title template/u.test(message)
      ? 'invalid-title-format'
      : /tool call|tool-calls/u.test(message)
        ? 'tool-output'
        : /timed out|timeout/u.test(message)
          ? 'timeout'
          : /terminal finish|stream failed|missing/u.test(message)
            ? 'stream-failure'
            : 'provider-failure';
  return `attempt ${attempt}/${attempts} ${code}: ${category}`;
}

/**
 * Report whether another attempt can plausibly succeed.
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
