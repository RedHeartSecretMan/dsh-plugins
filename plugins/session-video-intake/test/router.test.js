import assert from 'node:assert/strict';
import test from 'node:test';
import { containsVideoInput, createVideoRouter } from '../lib/router.js';

const video = (name = 'clip.mp4') => ({
  role: 'user',
  content: [{ type: 'text', text: 'describe this' }, { type: 'file', attachment: { name } }],
});
const text = (value) => ({ role: 'user', content: [{ type: 'text', text: value }] });

function makeScopedAgent(history = []) {
  const listeners = new Map();
  const ctx = {
    on(name, listener, options = {}) {
      const list = listeners.get(name) ?? [];
      if (options.prepend) list.unshift(listener);
      else list.push(listener);
      listeners.set(name, list);
      return () => {
        const current = listeners.get(name) ?? [];
        const index = current.indexOf(listener);
        if (index >= 0) current.splice(index, 1);
      };
    },
  };
  return { ctx, session: { deriveMessages: () => history }, listeners };
}

function fixture({ history = [], video: hasVideo = true, image = true, maxOutputTokens } = {}) {
  const rootListeners = new Map();
  const agent = makeScopedAgent(history);
  const agents = { list: () => [agent] };
  const ctx = {
    get(name) { return name === 'agents' ? agents : undefined; },
    on(name, listener) {
      const list = rootListeners.get(name) ?? [];
      list.push(listener);
      rootListeners.set(name, list);
      return () => {
        const current = rootListeners.get(name) ?? [];
        const index = current.indexOf(listener);
        if (index >= 0) current.splice(index, 1);
      };
    },
  };
  const capability = {
    async get(provider, model) {
      return { provider, model, video: hasVideo, image, injectable: true };
    },
  };
  const invoke = async (agentForCall, name, payload, terminal) => {
    let next = terminal;
    for (const listener of [...(agentForCall.listeners.get(name) ?? [])].reverse()) {
      const downstream = next;
      next = () => listener(payload, downstream);
    }
    return next();
  };
  const emitRoot = async (name, payload) => {
    for (const listener of [...(rootListeners.get(name) ?? [])]) await listener(payload);
  };
  const dispose = createVideoRouter(ctx, { capability, maxOutputTokens });
  return { agent, invoke, emitRoot, dispose, makeAgent: makeScopedAgent };
}

async function routeAfterVideo(f, messages, resolved = {
  provider: 'magpie-responses', model: 'codex/gpt-6.1-sol', reasoningEffort: 'high', maxTokens: 128000,
}) {
  const signal = new AbortController().signal;
  await f.invoke(f.agent, 'agent/pre-step', { agent: f.agent, messages, signal }, async () => ({ kind: 'enter', messages }));
  return f.invoke(f.agent, 'agent/request', { agent: f.agent, signal }, async () => resolved);
}

test('a native-video route keeps the selected provider and model', async () => {
  const f = fixture({ video: true });
  const resolved = await routeAfterVideo(f, [video()]);
  assert.equal(resolved.provider, 'magpie-responses');
  assert.equal(resolved.model, 'codex/gpt-6.1-sol');
});

test('an image-only route also keeps the selected route (storyboard later)', async () => {
  const f = fixture({ video: false, image: true });
  const resolved = await routeAfterVideo(f, [video()]);
  assert.equal(resolved.provider, 'magpie-responses');
  assert.equal(resolved.model, 'codex/gpt-6.1-sol');
});

test('a route with neither capability fails before prepareCall', async () => {
  const f = fixture({ video: false, image: false });
  await assert.rejects(routeAfterVideo(f, [video()]), { code: 'VIDEO_UNSUPPORTED' });
});

test('ordinary input never changes the route object', async () => {
  const f = fixture();
  const original = { provider: 'magpie-responses', model: 'codex/gpt-6.1-sol', maxTokens: 128000 };
  await f.invoke(f.agent, 'agent/pre-step', {
    agent: f.agent, messages: [text('ordinary text')], signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [text('ordinary text')] }));
  const resolved = await f.invoke(f.agent, 'agent/request', { agent: f.agent }, async () => original);
  assert.equal(resolved, original);
});

test('a session with video history is checked on later turns', async () => {
  const f = fixture({ history: [video()], video: false, image: false });
  await assert.rejects(routeAfterVideo(f, [text('what changed?')]), { code: 'VIDEO_UNSUPPORTED' });
});

test('the configured output cap overrides a larger inherited budget', async () => {
  const f = fixture({ maxOutputTokens: 4096 });
  const resolved = await routeAfterVideo(f, [video()]);
  assert.equal(resolved.maxTokens, 4096);
  assert.equal(resolved.reasoningEffort, 'high');
});

test('assistant/tool URLs, markdown and non-video files do not trigger video handling', async () => {
  const f = fixture({ video: false, image: false });
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: 'https://example.test/a.mp4' }] },
    { role: 'tool', content: [{ type: 'text', text: 'https://example.test/b.webm' }] },
    text('[clip](https://example.test/c.mp4) `https://example.test/d.webm`'),
    { role: 'user', content: [{ type: 'file', attachment: { name: 'clip.mov' } }] },
  ];
  await f.invoke(f.agent, 'agent/pre-step', {
    agent: f.agent, messages, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages }));
  const resolved = await f.invoke(f.agent, 'agent/request', { agent: f.agent }, async () => ({ provider: 'magpie-responses', model: 'codex/gpt-6.1-sol' }));
  assert.equal(resolved.provider, 'magpie-responses');
});

test('future agents are installed and state is isolated per agent', async () => {
  const f = fixture({ video: false, image: false });
  const future = f.makeAgent();
  await f.emitRoot('agent/created', { agent: future });
  const signal = new AbortController().signal;
  await f.invoke(future, 'agent/pre-step', { agent: future, messages: [video()], signal }, async () => ({ kind: 'enter', messages: [video()] }));
  await assert.rejects(
    f.invoke(future, 'agent/request', { agent: future }, async () => ({ provider: 'magpie-responses', model: 'codex/gpt-6.1-sol' })),
    { code: 'VIDEO_UNSUPPORTED' },
  );

  const other = f.makeAgent();
  const otherResolved = await f.invoke(other, 'agent/request', { agent: other }, async () => ({ provider: 'magpie', model: 'auto/deepseek-flash' }));
  assert.equal(otherResolved.provider, 'magpie');
});

test('disposer removes existing and future agent hooks', async () => {
  const f = fixture({ video: false, image: false });
  const signal = new AbortController().signal;
  await f.invoke(f.agent, 'agent/pre-step', { agent: f.agent, messages: [video()], signal }, async () => ({ kind: 'enter', messages: [video()] }));
  f.dispose();
  const resolved = await f.invoke(f.agent, 'agent/request', { agent: f.agent }, async () => ({ provider: 'magpie-responses', model: 'codex/gpt-6.1-sol' }));
  assert.equal(resolved.provider, 'magpie-responses');
});

test('containsVideoInput only accepts user-originated video', () => {
  assert.equal(containsVideoInput([video()]), true);
  assert.equal(containsVideoInput([text('https://cdn.test/clip.webm')]), true);
  assert.equal(containsVideoInput([{ role: 'assistant', content: [{ type: 'text', text: 'https://cdn.test/clip.mp4' }] }]), false);
  assert.equal(containsVideoInput([{ role: 'user', content: [{ type: 'file', attachment: { name: 'clip.mov' } }] }]), false);
});
