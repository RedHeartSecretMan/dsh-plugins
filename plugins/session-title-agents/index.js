/** Structured titles for the DeepSeek Harness 0.2.1 provider contract. */
import { randomUUID } from 'node:crypto';
import { resolveConfig } from './lib/config.js';
import { createStateStore, stateDirectory } from './lib/state.js';
import { backfillTitles } from './lib/backfill.js';
import { buildFallbackTitle, buildSystemPrompt, compileTitlePattern, formatDate, frameMessages, isFormattedTitle, isSettledTitle, parseModelTitle, selectContextMessages } from './lib/title.js';

export const name = 'session-title-agents';
export const inject = ['sessionTitle', 'llm', 'sessions', 'sessionProjections'];

function resolveRoute(config, request, ctx) {
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
async function titleCall(ctx, config, request, route, system, input, messageSeqs, signal) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('session-title-agents: title request timed out')), config.timeoutMs);
  timer.unref?.();
  const combined = AbortSignal.any([signal, timeout.signal]);
  try {
    combined.throwIfAborted();
    if (Buffer.byteLength(input, 'utf8') > config.maxInputBytes) throw new Error('session-title-agents: input byte budget exceeded');
    const call = await ctx.llm.prepareCall({ ...route, maxTokens: config.maxOutputTokens }, combined, (controls, model) => {
      const effort = model.reasoning?.efforts?.[0]?.id;
      return { ...controls, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
    });
    const messages = [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: input }], source: { kind: name } }];
    const options = { ...call.config, messages, system, sessionId: request.session.id, purpose: 'session-title', signal: combined };
    combined.throwIfAborted();
    // Use the built-in event type and payload, so auxiliary requests remain replayable.
    request.session.append('session/title-llm-request', {
      titleProvider: name, messageSeqs, route, system, messages, maxTokens: config.maxOutputTokens,
      ...(call.config.reasoningEffort === undefined ? {} : { reasoningEffort: call.config.reasoningEffort }),
    });
    const blocks = new Map();
    let finish;
    for await (const chunk of call.stream(options)) {
      combined.throwIfAborted();
      const index = chunk.index ?? 0;
      if (chunk.type === 'finish') { finish = chunk.reason; continue; }
      if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')) {
        throw new Error('session-title-agents: title response must not contain tool calls');
      }
      if (chunk.type === 'block-end') {
        if (chunk.block.type === 'tool-call') throw new Error('session-title-agents: title response contains a tool call');
        if (!blocks.get(index)?.closed) blocks.set(index, { text: chunk.block.type === 'text' ? chunk.block.text : '', closed: true });
      } else if (chunk.type === 'text-delta' && !blocks.get(index)?.closed) {
        blocks.set(index, { text: (blocks.get(index)?.text ?? '') + chunk.text, closed: false });
      }
    }
    combined.throwIfAborted();
    if (finish?.kind !== 'stop') {
      const error = new Error(`session-title-agents: unsuccessful terminal finish (${finish?.kind ?? 'missing'})`);
      error.code = finish?.failure?.code ?? 'TITLE_STREAM_FAILED';
      throw error;
    }
    return [...blocks.values()].map(block => block.text).join(' ');
  } finally { clearTimeout(timer); }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const lifetime = new AbortController();
  const profileDirectory = ctx.get?.('profileContext')?.dir;
  const state = createStateStore({ directory: stateDirectory({ ...process.env, ...(profileDirectory ? { DSH_PROFILE_DIR: profileDirectory } : {}) }) });
  const pattern = compileTitlePattern(config.template, config.types.map(type => type.key));
  const activeRetitles = new Map();
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
      if (!messages.length) throw new Error('session-title-agents: at least one human message is required');
      const date = formatDate(request.session.header?.createdAt, config.timezone, config.dateFormat);
      const options = titleOptions(date);
      const current = request.currentTitle ?? ctx.sessionTitle.get(request.session);
      const hint = activeRetitles.get(String(request.session.id));
      const forced = activeRetitles.has(String(request.session.id));
      if (!forced && current?.source.kind === 'provider' &&
          (isSettledTitle(current.title, options) || (isFormattedTitle(current.title, options) && messages.length > config.maxProvisionalRefinements))) {
        // The host has no custom "skip" error protocol. Return an unchanged valid
        // result like the shipped provider, avoiding warnings on normal stability.
        const available = new Set(messages.map(message => message.seq));
        const cited = (current.messageSeqs ?? []).filter(seq => available.has(seq));
        return { title: current.title, messageSeqs: cited.length ? cited : [messages[0].seq] };
      }
      const selected = selectContextMessages(messages, config.maxInputBytes);
      if (!selected.length) throw new Error('session-title-agents: no input fits the configured byte budget');
      const messageSeqs = selected.map(message => message.seq);
      let route = resolveRoute(config, request, ctx);
      const fallbackRoute = config.backfill.fallbackRoute;
      if (forced && fallbackRoute) route = fallbackRoute;
      if (!route) {
        if (current && isFormattedTitle(current.title, options)) return { title: current.title, messageSeqs };
        return { title: buildFallbackTitle({ date, template: config.template, fallbackType: config.fallbackType, sourceText: messages[0].text, cjkSpacing: config.cjkSpacing, topicMaxChars: config.topicMaxChars }), messageSeqs };
      }
      const system = buildSystemPrompt({ ...config, template: config.template, dateLabel: date, typeLabel: config.types[0].key, topicLabel: config.language === 'en' ? 'Topic' : '主题', isRefining: messages.length > 1, hint });
      const input = frameMessages(selected);
      const routes = [route];
      if (fallbackRoute && (route.provider !== fallbackRoute.provider || route.model !== fallbackRoute.model)) routes.push(fallbackRoute);
      let failure;
      for (const target of routes) {
        try {
          const text = await titleCall(ctx, config, request, target, system, input, messageSeqs, signal);
          signal.throwIfAborted();
          const parsed = parseModelTitle(text, options);
          if (!parsed) throw new Error('session-title-agents: model output did not match the title template');
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
    lifetime.abort(new Error('session-title-agents: plugin disposed'));
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
