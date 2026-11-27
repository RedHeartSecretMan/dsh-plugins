import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = await mkdtemp(join(tmpdir(), 'session-title-template-regression-'));
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
test('a legacy formatted fallback recovers after the refinement window', async () => {
  const first = '分析我当前的 codex 中使用的模型有没有降智路由到垃圾模型';
  const old = '[1019][探索] 分析我当前的 codex 中使用的模';
  const f = fixture({ snapshot: { title: old, source: { kind: 'provider', provider: 'legacy', model: { provider: 'prior', model: 'prior-model' } }, messageSeqs: [1], eventSeq: 2 } });
  f.request.session.header.createdAt = 1792397271681;
  f.request.messages = Array.from({ length: 8 }, (_, i) => ({ seq: i + 1, text: i === 0 ? first : '调查并验证 Codex 模型路由' }));
  try {
    assert.notEqual((await f.generate({ agentsInstructions: { enabled: false } })).title, old);
    assert.equal(f.calls.length, 1);
  } finally { await f.dispose(); }
});
test('no-route formatted fallback is retried when a route becomes available', async () => {
  const old = '[1025][探索] 修复登录超时';
  const f = fixture({ snapshot: { title: old, source: { kind: 'provider' }, messageSeqs: [1], eventSeq: 2 } });
  f.request.messages = Array.from({ length: 6 }, (_, i) => ({ seq: i + 1, text: i ? '继续处理' : '修复登录超时' }));
  f.request.session.requestHeader = () => undefined;
  try {
    assert.equal((await f.generate({ agentsInstructions: { enabled: false } })).title, old);
    assert.equal(f.calls.length, 0);
    f.request.session.requestHeader = () => ({ config: { provider: 'recovered', model: 'model' } });
    assert.equal((await f.generate({ agentsInstructions: { enabled: false } })).title, title);
    assert.equal(f.calls.length, 1);
  } finally { await f.dispose(); }
});
test('retaining a good title preserves its successful model provenance', async () => {
  const model = { provider: 'prior', model: 'prior-model' };
  const f = fixture({ snapshot: { title, source: { kind: 'provider', model }, messageSeqs: [1], eventSeq: 2 } });
  f.request.messages.push({ seq: 3, text: '继续，不要变更标题' });
  try {
    const result = await f.generate();
    assert.equal(f.calls.length, 0);
    assert.deepEqual(result.model, model);
  } finally { await f.dispose(); }
});
test('event ordering alone never bypasses automatic stability', async () => {
  const old = '[1025][修复] 排查旧的登录问题';
  const f = fixture({ snapshot: { title: old, source: { kind: 'provider', model: { provider: 'prior', model: 'm' } }, messageSeqs: [1], eventSeq: 9 } });
  try {
    assert.equal((await f.generate({ agentsInstructions: { enabled: false } })).title, old);
    assert.equal(f.calls.length, 0);
  } finally { await f.dispose(); }
});
test('discussion of rename does not itself force an automatic rename', async () => {
  const f = fixture({ snapshot: { title, source: { kind: 'provider' }, messageSeqs: [1], eventSeq: 2 } });
  f.request.messages.push({ seq: 3, text: '分析插件是否应该扫描重命名标题这几个字' });
  try { assert.equal((await f.generate()).title, title); assert.equal(f.calls.length, 0); }
  finally { await f.dispose(); }
});

const finish = (kind = 'stop') => ({ type: 'finish', reason: { kind, failure: { code: 'MODEL_FAILED', message: 'model failed' } } });
function fixture({ snapshot, replies = [[{ type: 'text-delta', index: 0, text: title }, finish()]] } = {}) {
  let provider;
  const calls = [], effects = [], appends = [];
  const ctx = {
    effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') effects.push(cleanup); return cleanup; },
    inject(services, callback) { if (services.every(service => ctx[service])) callback(ctx); },
    logger: { info() {}, warn() {}, debug() {} }, get() {},
    sessionTitle: { register(value) { provider = value; }, get() { return snapshot; } },
    sessions: { get() {} }, sessionProjections: { stateOf() {}, register: async () => ({ dispose: async () => {} }) },
    commands: { register: () => () => {} },
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
  const session = { id: 'fixture', append(type, data) { appends.push({ type, data }); }, header: { createdAt: Date.UTC(2026, 9, 24, 17, 30) }, requestHeader: () => ({ config: { provider: 'primary', model: 'old-model' } }) };
  const request = { session, messages: [{ seq: 1, text: '修复登录超时' }], signal: new AbortController().signal, ...(snapshot ? { currentTitle: snapshot } : {}) };
  return { ctx, calls, appends, request, async generate(config = {}) { await apply(ctx, { roleProbe: { enabled: false }, ...config }); return provider.generate(request); }, dispose: async () => { for (const fn of effects.reverse()) await fn(); } };
}
test('first automatic fallback is not an explicit refresh and keeps the primary route', async () => {
  const f = fixture({ snapshot: { title: '修复登录超时', source: { kind: 'fallback' }, messageSeqs: [1], eventSeq: 2 } });
  try {
    await f.generate({ fallbackRoute: { provider: 'backup', model: 'm' }, agentsInstructions: { enabled: false } });
    assert.equal(f.calls[0].provider, 'primary');
    assert.doesNotMatch(f.calls[0].system, /Explicit refresh:/);
  } finally { await f.dispose(); }
});

test('host-truncated provider fallback is recoverable after the message window', async () => {
  const first = '调查 Codex 模型降级路由以及上下文窗口和后台审批配置'.repeat(3);
  const old = '[1025][探索] 调查 Codex 模型降级路由以及上下文窗口';
  const f = fixture({ snapshot: { title: old, source: { kind: 'provider' }, messageSeqs: [1], eventSeq: 2 } });
  f.request.messages = Array.from({ length: 6 }, (_, i) => ({ seq: i + 1, text: i ? '继续调查' : first }));
  try { assert.equal((await f.generate({ topicMaxChars: 64, agentsInstructions: { enabled: false } })).title, title); assert.equal(f.calls.length, 1); }
  finally { await f.dispose(); }
});

test('coordination delegates automatic naming while preserving explicit user rename', async () => {
  const f = fixture(); const sections = [];
  f.ctx.systemPrompt = {
    getSectionOrder: () => 2300,
    section(value) { sections.push(value); f.ctx.effect(() => () => sections.splice(sections.indexOf(value), 1)); },
  };
  try {
    await f.generate();
    assert.equal(sections.length, 1);
    assert.equal(sections[0].name, 'session-title-template:coordination');
    assert.match(sections[0].text, /Do not call a session rename tool/);
    assert.match(sections[0].text, /user explicitly asks to rename/);
  } finally { await f.dispose(); }
  assert.equal(sections.length, 0);
});
test('disabling AGENTS support skips coordination and working-directory lookup', async () => {
  const f = fixture();
  // The plugin also registers a projection, a command and a read-only status
  // route; this spec is about AGENTS support, so it only refuses systemPrompt.
  f.ctx.inject = services => { for (const service of services) {
    if (service === 'tools') continue;
    if (service === 'sessionProjections' || service === 'commands' || service === 'webServer') continue;
    throw new Error(`unexpected injection: ${service}`);
  } };
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
    const result = await f.generate({ fallbackRoute: { provider: 'backup', model: 'backup-model' } });
    assert.deepEqual(f.calls.map(c => c.provider), ['primary', 'backup']);
    assert.equal(result.title, title); assert.equal(result.model.provider, 'backup');
  } finally { await f.dispose(); }
});
test('partial output followed by terminal error is never committed', async () => {
  const f = fixture({ snapshot: { title: '[1025][探索] 排查登录问题', source: { kind: 'provider' }, messageSeqs: [1] }, replies: [[{ type: 'text-delta', index: 0, text: title }, finish('error')]] });
  f.request.messages.push({ seq: 2, text: '继续排查登录问题并补充更多运行日志以及完整的排查记录' });
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
  try { assert.equal((await f.generate({ backfill: { retitle: [{ id: 'fixture', hint: 'new hint' }] } })).title, title); assert.equal(f.calls.length, 0); } finally { await f.dispose(); }
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
  try { await assert.rejects(f.generate({ fallbackRoute: { provider: 'b', model: 'm' } }), e => e.name === 'AbortError'); } finally { await f.dispose(); }
});
test('auxiliary title request records the canonical message source kind', async () => {
  const f = fixture();
  try {
    await f.generate();
    const recorded = f.appends.filter(entry => entry.type === 'session/title-llm-request');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].data.titleProvider, 'session-title-template');
    assert.equal(recorded[0].data.messages.length, 1);
    assert.equal(recorded[0].data.messages[0].role, 'user');
    assert.deepEqual(recorded[0].data.messages[0].source, { kind: 'dsh-session-title-llm' });
  } finally { await f.dispose(); }
});

test('short acknowledgements keep a settled title without a model call', async () => {
  const model = { provider: 'prior', model: 'prior-model' };
  const f = fixture({ snapshot: { title, source: { kind: 'provider', model }, messageSeqs: [1], eventSeq: 2 } });
  f.request.messages.push({ seq: 3, text: '谢谢，继续' });
  try {
    const result = await f.generate();
    assert.equal(f.calls.length, 0);
    assert.equal(result.title, title);
    assert.deepEqual(result.messageSeqs, [1]);
    assert.deepEqual(result.model, model);
  } finally { await f.dispose(); }
});

test('an explicit topic-shift marker refreshes a settled title', async () => {
  const updated = '[1025][设计] 设计缓存层方案';
  const f = fixture({
    snapshot: { title, source: { kind: 'provider', model: { provider: 'prior', model: 'prior-model' } }, messageSeqs: [1], eventSeq: 2 },
    replies: [[{ type: 'text-delta', index: 0, text: updated }, finish()]],
  });
  f.request.messages.push({ seq: 3, text: '另外，帮我设计一个新的缓存层方案' });
  try {
    const result = await f.generate();
    assert.equal(f.calls.length, 1);
    assert.equal(result.title, updated);
    assert.deepEqual(result.messageSeqs, [1, 3]);
  } finally { await f.dispose(); }
});

test('a materially changed main task updates a settled title', async () => {
  const updated = '[1025][运维] 部署新的内网代理服务';
  const f = fixture({
    snapshot: { title, source: { kind: 'provider', model: { provider: 'prior', model: 'prior-model' } }, messageSeqs: [1], eventSeq: 2 },
    replies: [[{ type: 'text-delta', index: 0, text: updated }, finish()]],
  });
  f.request.messages.push({ seq: 3, text: '现在开始部署新的内网代理服务并验证网络连通性' });
  try {
    const result = await f.generate();
    assert.equal(f.calls.length, 1);
    assert.equal(result.title, updated);
  } finally { await f.dispose(); }
});

test('a model answer equal to the current provider title keeps its provenance', async () => {
  const model = { provider: 'prior', model: 'prior-model' };
  const f = fixture({ snapshot: { title, source: { kind: 'provider', model }, messageSeqs: [1], eventSeq: 2 } });
  f.request.messages.push({ seq: 3, text: '另外补充一下相关的排查结论和验证记录' });
  try {
    const result = await f.generate();
    assert.equal(f.calls.length, 1);
    assert.equal(result.title, title);
    assert.deepEqual(result.messageSeqs, [1]);
    assert.deepEqual(result.model, model);
  } finally { await f.dispose(); }
});

test('the current title anchors both the system prompt and the framed input', async () => {
  const current = { title: '[1025][探索] 排查旧的登录问题', canonical: true };
  const f = fixture({ snapshot: { title: current.title, source: { kind: 'provider', model: { provider: 'prior', model: 'm' } }, messageSeqs: [1], eventSeq: 2 } });
  f.request.messages.push({ seq: 3, text: '另外，请设计新的登录重试方案' });
  try {
    await f.generate();
    assert.ok(f.calls[0].system.includes(JSON.stringify(current)));
    assert.match(f.calls[0].system, /原样返回/);
    assert.match(f.calls[0].system, /实质性变化/);
    const input = f.calls[0].messages[0].content[0].text;
    assert.match(input, /^Update the session title from this JSON object:/u);
    const payload = JSON.parse(input.slice(input.indexOf('{')));
    assert.deepEqual(payload.currentTitle, current);
    assert.deepEqual(payload.messages.map(message => message.seq), [1, 3]);
  } finally { await f.dispose(); }
});

test('read-only status routes inspect live sessions without createdAt and cold sessions via sessionQuery', async () => {
  const f = fixture();
  const routes = [];
  const liveSession = { id: 'live-no-date', header: {} };
  const coldEvents = [
    { type: 'workspace-root/change', data: { cwd: scratch } },
    { type: 'session/title', time: 5000, data: { title: '[1125][修复] 冷会话标题', source: { kind: 'provider' }, messageSeqs: [1] } },
  ];
  f.ctx.sessions = { get: id => (id === 'live-no-date' ? liveSession : undefined) };
  f.ctx.sessionTitle = {
    register() {},
    get: session => (session === liveSession ? { title: '[1125][优化] 活会话标题', source: { kind: 'user' }, messageSeqs: [] } : undefined),
  };
  f.ctx.webServer = { register(route) { routes.push(route); return () => {}; } };
  f.ctx.get = key => (key === 'sessionQuery'
    ? { readSession: async id => (id === 'cold-1' ? { session: { id, cwd: scratch }, events: coldEvents } : (() => { throw new Error('ENOENT'); })()) }
    : undefined);

  let registeredProjection = false;
  f.ctx.sessionProjections = {
    stateOf() {},
    register: async () => { registeredProjection = true; return { dispose: async () => {} }; },
  };

  try {
    await apply(f.ctx, { roleProbe: { enabled: false }, agentsInstructions: { enabled: false } });
    assert.equal(registeredProjection, true, 'sessionProjections.register should be awaited directly in apply');
    const statusRoute = routes.find(r => r.path === '/session-title-template/status');
    assert.ok(statusRoute);

    const makeRes = () => {
      let body = '';
      return { statusCode: 0, setHeader() {}, end(c = '') { body += c; }, json() { return JSON.parse(body); } };
    };
    const owner = { principal: { kind: 'owner' } };

    const resLive = makeRes();
    await statusRoute.handler({ method: 'GET', url: '/session-title-template/status?sessionId=live-no-date' }, resLive, owner);
    assert.equal(resLive.statusCode, 200);
    assert.equal(resLive.json().live, true);
    assert.equal(resLive.json().snapshot.title.value, '[1125][优化] 活会话标题');

    const resCold = makeRes();
    await statusRoute.handler({ method: 'GET', url: '/session-title-template/status?sessionId=cold-1' }, resCold, owner);
    assert.equal(resCold.statusCode, 200);
    assert.equal(resCold.json().live, false);
    assert.equal(resCold.json().snapshot.title.value, '[1125][修复] 冷会话标题');

    const resMissing = makeRes();
    await statusRoute.handler({ method: 'GET', url: '/session-title-template/status?sessionId=no-such-session' }, resMissing, owner);
    assert.equal(resMissing.statusCode, 404);
    assert.equal(resMissing.json().code, 'session-not-found');
  } finally { await f.dispose(); }
});


test('the settings route saves through configEditor only for an addressable plugin entry', async () => {
  for (const addressable of [true, false]) {
    const f = fixture();
    const routes = [];
    const entry = { options: { id: 'session-title-template' } };
    const edits = [];
    const editor = {
      entries: () => (addressable ? [entry] : []),
      edit: async (target, change) => { edits.push({ target, next: change({ language: 'zh' }, {}) }); },
    };
    f.ctx.fiber = { entry };
    f.ctx.webServer = { register(route) { routes.push(route); return () => {}; } };
    f.ctx.get = key => (key === 'configEditor' ? editor : undefined);
    try {
      await apply(f.ctx, { roleProbe: { enabled: false }, agentsInstructions: { enabled: false } });
      const route = routes.find(r => r.path === '/session-title-template/settings');
      assert.ok(route, 'the settings route must be registered with the Host web server');
      const makeRes = () => {
        let body = '';
        return { statusCode: 0, setHeader() {}, end(c = '') { body += c; }, json() { return JSON.parse(body); } };
      };
      const owner = { principal: { kind: 'owner' } };

      const read = makeRes();
      await route.handler({ method: 'GET' }, read, owner);
      assert.equal(read.json().editable, addressable);

      const write = makeRes();
      await route.handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { changes: { language: 'en' } } }, write, owner);
      if (addressable) {
        assert.equal(write.statusCode, 200);
        assert.equal(edits.length, 1);
        assert.equal(edits[0].target, entry, 'the write targets this plugin\'s own fiber entry');
        assert.equal(edits[0].next.language, 'en');
      } else {
        assert.equal(write.statusCode, 409);
        assert.equal(edits.length, 0, 'a row outside the root Include is never written');
      }
    } finally { await f.dispose(); }
  }
});
