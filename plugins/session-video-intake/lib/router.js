/**
 * Decide how the current route consumes a video before `prepareCall()` binds an
 * adapter. The route itself is never changed: native video stays on the route,
 * image-only routes get a storyboard, and routes with neither capability fail.
 */
import { assertVideoCapability } from './capability.js';
import { failure } from './failure.js';
import { findBareVideoUrls, isVideoFileName } from './media-input.js';

export { isVideoFileName } from './media-input.js';

function contentHasVideo(content) {
  if (typeof content === 'string') return findBareVideoUrls(content).length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (block?.type === 'file') return isVideoFileName(block.attachment?.name ?? block.name);
    return block?.type === 'text' && findBareVideoUrls(block.text).length > 0;
  });
}

/**
 * Detect only user-originated video inputs before the core projects FileBlocks
 * into file-handle text. Assistant/tool/system URLs remain ordinary content.
 */
export function containsVideoInput(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => message?.role === 'user' && contentHasVideo(message.content));
}

function installAgentRouter(agent, states, options) {
  const agentCtx = agent?.ctx;
  if (typeof agentCtx?.on !== 'function') throw new Error('session-video-intake: agent-scoped request hooks are unavailable');
  const { capability, maxOutputTokens } = options;

  const disposePreStep = agentCtx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    const currentAgent = payload?.agent ?? agent;
    if (payload?.signal?.aborted || decision?.kind === 'reject') return decision;

    let history;
    try {
      history = currentAgent.session?.deriveMessages?.();
    } catch {
      history = undefined;
    }
    if (containsVideoInput(payload?.messages) ||
        containsVideoInput(decision?.messages) ||
        containsVideoInput(history)) {
      states.set(currentAgent, true);
    }
    return decision;
  }, { prepend: true });

  const disposeRequest = agentCtx.on('agent/request', async (payload, next) => {
    const resolved = await next();
    const currentAgent = payload?.agent ?? agent;
    if (!states.get(currentAgent)) return resolved;
    if (typeof resolved?.provider !== 'string' || typeof resolved?.model !== 'string') {
      throw failure('the current request has no provider/model route', 'VIDEO_UNSUPPORTED');
    }

    const capabilityInfo = await capability.get(resolved.provider, resolved.model);
    assertVideoCapability(capabilityInfo);

    if (!Number.isSafeInteger(maxOutputTokens) ||
        !Number.isSafeInteger(resolved.maxTokens) ||
        resolved.maxTokens <= maxOutputTokens) {
      return resolved;
    }
    return { ...resolved, maxTokens: maxOutputTokens };
  }, { prepend: true });

  return () => {
    disposePreStep?.();
    disposeRequest?.();
  };
}

/**
 * Install agent-scoped capability checks for existing and future agents. Every
 * agent keeps its own state, so concurrent sessions cannot affect each other.
 */
export function createVideoRouter(ctx, options = {}) {
  const { capability } = options;
  if (!capability || typeof capability.get !== 'function') {
    throw failure('capability resolver is required', 'VIDEO_INVALID_CONFIG');
  }
  const agents = ctx?.agents ?? ctx?.get?.('agents');
  if (!agents || typeof agents.list !== 'function') return () => {};

  const states = new WeakMap();
  const installed = new WeakSet();
  const disposers = new Map();
  const install = (agent) => {
    if (!agent || installed.has(agent)) return;
    disposers.set(agent, installAgentRouter(agent, states, options));
    installed.add(agent);
  };
  const disposeAgent = (agent) => {
    disposers.get(agent)?.();
    disposers.delete(agent);
    states.delete(agent);
  };

  for (const agent of agents.list()) install(agent);
  const disposeCreated = ctx.on('agent/created', ({ agent }) => install(agent));
  const disposeDisposed = ctx.on('agent/disposed', ({ agent }) => disposeAgent(agent));
  return () => {
    disposeCreated?.();
    disposeDisposed?.();
    for (const agent of [...disposers.keys()]) disposeAgent(agent);
  };
}
