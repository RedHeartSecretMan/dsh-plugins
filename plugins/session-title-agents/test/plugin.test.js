import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = await mkdtemp(join(tmpdir(), 'session-title-agents-regression-'));
const previous = Object.fromEntries(['DSH_PROFILE_DIR', 'DSH_HOME', 'DSH_AGENTS_HOME'].map(key => [key, process.env[key]]));
process.env.DSH_PROFILE_DIR = scratch;
process.env.DSH_HOME = join(scratch, 'harness');
process.env.DSH_AGENTS_HOME = join(scratch, 'shared');
after(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(scratch, { recursive: true, force: true });
});
const { apply } = await import('../index.js');
const title = '[1025][修复] 排查登录超时';
const finish = (kind = 'stop') => ({ type: 'finish', reason: { kind, failure: { code: 'MODEL_FAILED', message: 'model failed' } } });
function fixture({ snapshot, replies = [[{ type: 'text-delta', index: 0, text: title }, finish()]] } = {}) {
  let provider;
  const calls = [], effects = [];
  const ctx = {
    effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') effects.push(cleanup); return cleanup; },
    inject(services, callback) { if (services.every(service => ctx[service])) callback(ctx); },
    logger: { info() {}, warn() {}, debug() {} }, get() {},
    sessionTitle: { register(value) { provider = value; }, get() { return snapshot; } },
    sessions: { get() {} }, sessionProjections: { stateOf() {} },
    llm: {
      async prepareCall(config, signal, select) {
        const controls = select ? select(config, { reasoning: { efforts: [{ id: 'low' }] } }) : config;
        return { config: controls, stream: (options) => this.stream(options) };
      },
      async *stream(options) {
        const reply = replies[Math.min(calls.length, replies.length - 1)]; calls.push(options);
        for (const chunk of reply) yield chunk;
      },
    },
  };
  const session = { id: 'fixture', append() {}, header: { createdAt: Date.UTC(2026, 9, 24, 17, 30) }, requestHeader: () => ({ config: { provider: 'primary', model: 'old-model' } }) };
  const request = { session, messages: [{ seq: 1, text: '修复登录超时' }], signal: new AbortController().signal, ...(snapshot ? { currentTitle: snapshot } : {}) };
  return { ctx, calls, request, generate(config = {}) { apply(ctx, config); return provider.generate(request); }, dispose: async () => { for (const fn of effects.reverse()) await fn(); } };
}
test('coordination delegates automatic naming while preserving explicit user rename', async () => {
  const f = fixture(); const sections = [];
  f.ctx.systemPrompt = {
    getSectionOrder: () => 2300,
    section(value) { sections.push(value); f.ctx.effect(() => () => sections.splice(sections.indexOf(value), 1)); },
  };
  try {
    await f.generate();
    assert.equal(sections.length, 1);
    assert.equal(sections[0].name, 'session-title-agents:coordination');
    assert.match(sections[0].text, /Do not call a session rename tool/);
    assert.match(sections[0].text, /user explicitly asks to rename/);
  } finally { await f.dispose(); }
  assert.equal(sections.length, 0);
});
test('disabling AGENTS support skips coordination and working-directory lookup', async () => {
  const f = fixture();
  f.ctx.inject = () => { throw new Error('coordination should be disabled'); };
  f.ctx.get = key => { if (key === 'workingDirectory') throw new Error('lookup should be disabled'); };
  try { assert.equal((await f.generate({ agentsInstructions: { enabled: false } })).title, title); }
  finally { await f.dispose(); }
});
test('unavailable instruction discovery still allows ordinary title generation', async () => {
  const f = fixture(); f.request.session.header.cwd = scratch;
  try { assert.equal((await f.generate()).title, title); assert.equal(f.calls.length, 1); }
  finally { await f.dispose(); }
});
test('terminal error uses the configured fallback route', async () => {
  const f = fixture({ replies: [[finish('error')], [{ type: 'text-delta', index: 0, text: title }, finish()]] });
  try {
    const result = await f.generate({ backfill: { fallbackRoute: { provider: 'backup', model: 'backup-model' } } });
    assert.deepEqual(f.calls.map(c => c.provider), ['primary', 'backup']);
    assert.equal(result.title, title); assert.equal(result.model.provider, 'backup');
  } finally { await f.dispose(); }
});
test('partial output followed by terminal error is never committed', async () => {
  const f = fixture({ snapshot: { title: '[1025][探索] 排查登录问题', source: { kind: 'provider' }, messageSeqs: [1] }, replies: [[{ type: 'text-delta', index: 0, text: title }, finish('error')]] });
  try { await assert.rejects(f.generate(), /model failed|MODEL_FAILED|finish|terminal/i); } finally { await f.dispose(); }
});
test('closed text block wins without duplicating deltas', async () => {
  const f = fixture({ replies: [[{ type: 'text-delta', index: 0, text: '[1025][修复] 草稿' }, { type: 'block-end', index: 0, block: { type: 'text', text: title } }, finish()]] });
  try { assert.equal((await f.generate()).title, title); } finally { await f.dispose(); }
});
test('settled provider title returns unchanged without warning errors', async () => {
  const snapshot = { title, source: { kind: 'provider', model: { provider: 'prior', model: 'prior-model' } }, messageSeqs: [1] };
  const f = fixture({ snapshot }); f.request.messages.push({ seq: 2, text: '继续' });
  try { const result = await f.generate(); assert.equal(result.title, title); assert.equal(f.calls.length, 0); assert.deepEqual(result.messageSeqs, [1]); } finally { await f.dispose(); }
});
test('missing creation time does not become today', async () => {
  const f = fixture(); delete f.request.session.header.createdAt;
  try { await assert.rejects(f.generate(), /created|timestamp|date/i); assert.equal(f.calls.length, 0); } finally { await f.dispose(); }
});
test('retitle does not force normal prompts with backfill disabled', async () => {
  const f = fixture({ snapshot: { title, source: { kind: 'provider' }, messageSeqs: [1] } }); f.request.messages.push({ seq: 2, text: '继续' });
  try { assert.equal((await f.generate({ retitle: [{ id: 'fixture', hint: 'new hint' }] })).title, title); assert.equal(f.calls.length, 0); } finally { await f.dispose(); }
});
test('truncated and tool-call finishes never commit partial text', async () => {
  for (const kind of ['max-tokens', 'tool-calls', 'aborted']) {
    const f = fixture({ replies: [[{ type: 'text-delta', index: 0, text: title }, finish(kind)]] });
    try { await assert.rejects(f.generate()); } finally { await f.dispose(); }
  }
});
test('unload before the maintenance timer fires prevents any backfill work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let reads = 0;
  f.ctx.get = () => ({ listSessions: async () => { reads++; return []; }, readSession: async () => ({}), resume: async () => ({}) });
  // Register without invoking the title provider.
  apply(f.ctx, { backfill: { enabled: true } });
  await f.dispose();
  t.mock.timers.tick(3000);
  await Promise.resolve();
  assert.equal(reads, 0);
});
test('an abort just as the iterator closes is still rejected', async () => {
  const f = fixture(); const abort = new AbortController(); f.request.signal = abort.signal;
  f.ctx.llm.stream = async function* () { yield { type: 'text-delta', index: 0, text: title }; yield finish(); abort.abort(); };
  try { await assert.rejects(f.generate(), e => e.name === 'AbortError'); } finally { await f.dispose(); }
});
test('cancellation during a stream does not start a fallback request', async () => {
  const f = fixture(); const abort = new AbortController(); f.request.signal = abort.signal;
  f.ctx.llm.stream = async function* () { abort.abort(); yield finish('aborted'); };
  try { await assert.rejects(f.generate({ backfill: { fallbackRoute: { provider: 'b', model: 'm' } } }), e => e.name === 'AbortError'); } finally { await f.dispose(); }
});
