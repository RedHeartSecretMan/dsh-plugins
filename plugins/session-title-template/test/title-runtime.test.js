import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  resolveContext, keepCurrent, decidePlan, selectInput, resolveTargets, composePrompt, createTitleRuntime,
} = await import('../lib/title-runtime.js');
const { resolveConfig } = await import('../lib/config.js');
const { compileTitlePattern } = await import('../lib/title.js');

const config = resolveConfig({ language: 'zh' });
const pattern = compileTitlePattern(config.template, config.types.map(entry => entry.key));

/** A provider request carrying one user message. */
function request(overrides = {}) {
  return {
    session: { id: 'S1', header: { createdAt: Date.UTC(2026, 10, 24, 4, 0) } },
    messages: [{ seq: 1, text: '修复登录超时' }],
    signal: new AbortController().signal,
    ...overrides,
  };
}

const deps = { config, pattern, sessionTitle: { get: () => undefined } };

test('a context carries the messages, date, options and session identity', () => {
  const context = resolveContext(request(), deps);
  assert.equal(context.sessionId, 'S1');
  assert.equal(context.messages.length, 1);
  assert.match(context.date, /^\d{4}$/u);
  assert.equal(context.options.template, config.template);
  assert.equal(context.isSubagent, false);
});

test('a request without messages is rejected before any other work', () => {
  assert.throws(() => resolveContext(request({ messages: [] }), deps), /at least one human message/u);
});

test('a subagent context reads its delegation label', () => {
  const session = {
    id: 'S2',
    header: { createdAt: Date.UTC(2026, 10, 24), origin: 'subagent' },
    snapshotEvents: () => [{ type: 'subagent/descriptor', data: { label: '核查数据来源' } }],
  };
  const context = resolveContext(request({ session }), deps);
  assert.equal(context.isSubagent, true);
  assert.equal(context.delegationLabel, '核查数据来源');
});

test('keepCurrent preserves the title and drops cited messages that no longer exist', () => {
  const context = resolveContext(request(), deps);
  context.current = { title: '[1124][修复] 旧标题', source: { kind: 'provider', model: { provider: 'p', model: 'm' } }, messageSeqs: [1, 99] };
  const kept = keepCurrent(context);
  assert.equal(kept.title, '[1124][修复] 旧标题');
  assert.deepEqual(kept.messageSeqs, [1], 'a cite that no longer exists is dropped');
  assert.deepEqual(kept.model, { provider: 'p', model: 'm' });
});

test('keepCurrent falls back to the first message when no cite survives', () => {
  const context = resolveContext(request(), deps);
  context.current = { title: 'x', source: { kind: 'user' }, messageSeqs: [99] };
  assert.deepEqual(keepCurrent(context).messageSeqs, [1]);
});

test('keepCurrent omits the model for a non-provider title', () => {
  const context = resolveContext(request(), deps);
  context.current = { title: 'x', source: { kind: 'user' }, messageSeqs: [1] };
  assert.equal(keepCurrent(context).model, undefined);
});

test('an explicit refresh forces a plan even for a stable title', () => {
  const context = resolveContext(request(), deps);
  context.current = { title: '[1124][修复] 已有标题', source: { kind: 'provider' }, messageSeqs: [1] };
  assert.equal(decidePlan(context, {}).refresh, false);
  assert.equal(decidePlan(context, { explicitRefresh: true }).refresh, true);
});

test('selectInput returns the messages that fit the budget', () => {
  const context = resolveContext(request(), deps);
  const plan = { currentTitle: undefined };
  assert.equal(selectInput(context, config, plan).messageSeqs.length, 1);
});

test('an impossible budget is a configuration error, not a silent skip', () => {
  const context = resolveContext(request(), deps);
  // The byte budget cannot fit even the empty frame; a caller must see this
  // rather than receive an empty selection it might mistake for "no messages".
  assert.throws(() => selectInput(context, { ...config, maxInputBytes: 1 }, { currentTitle: undefined }), /maxInputBytes/u);
});

test('resolveTargets always includes the configured fallback route once', () => {
  const withFallback = { ...config, fallbackRoute: { provider: 'backup', model: 'b' } };
  const ctx = { sessionProjections: { stateOf: () => undefined }, llm: {} };
  const session = { header: { createdAt: 1 }, requestHeader: () => ({ config: { provider: 'primary', model: 'm' } }) };
  const targets = resolveTargets(withFallback, { session }, { targeted: false }, ctx);
  assert.deepEqual(targets.routes.map(route => route.provider), ['primary', 'backup']);
  // A targeted retitle prefers the fallback so the retitle is not judged by the
  // endpoint that produced the title being replaced.
  const targeted = resolveTargets(withFallback, { session }, { targeted: true }, ctx);
  assert.equal(targeted.routes[0].provider, 'backup');
});

test('resolveTargets reports no routes when none resolves', () => {
  const ctx = { sessionProjections: { stateOf: () => undefined }, llm: {} };
  const session = { header: { createdAt: 1 }, requestHeader: () => undefined };
  assert.equal(resolveTargets(config, { session }, { targeted: false }, ctx).none, true);
});

test('resolveTargets routes subagents to subagentRoute when set, otherwise follows main config', () => {
  const ctx = { sessionProjections: { stateOf: () => undefined }, llm: {} };
  const withSubagent = resolveConfig({
    provider: 'main-p',
    model: 'main-m',
    subagentRoute: { provider: 'sub-p', model: 'sub-m' },
    fallbackRoute: { provider: 'fb-p', model: 'fb-m' },
  });
  const rootSession = { header: { createdAt: 1 } };
  const subSession = { header: { createdAt: 1, origin: 'subagent' } };

  const rootTargets = resolveTargets(withSubagent, { session: rootSession }, { targeted: false }, ctx);
  assert.deepEqual(rootTargets.routes, [{ provider: 'main-p', model: 'main-m' }, { provider: 'fb-p', model: 'fb-m' }]);

  const subTargets = resolveTargets(withSubagent, { session: subSession }, { targeted: false }, ctx);
  assert.deepEqual(subTargets.routes, [{ provider: 'sub-p', model: 'sub-m' }, { provider: 'fb-p', model: 'fb-m' }]);

  // Without subagentRoute, a subagent falls back to the main agent config.
  const withoutSubagent = resolveConfig({ provider: 'main-p', model: 'main-m' });
  const inherited = resolveTargets(withoutSubagent, { session: subSession }, { targeted: false }, ctx);
  assert.deepEqual(inherited.routes, [{ provider: 'main-p', model: 'main-m' }]);
});

test('the composed prompt names the template and the current title anchor', () => {
  const context = resolveContext(request(), deps);
  const plan = { currentTitle: { title: '[1124][修复] 旧标题', canonical: true }, hint: undefined };
  const prompt = composePrompt(context, config, plan, context.messages, undefined);
  assert.match(prompt.system, /\[\{date\}\]\[\{type\}\] \{topic\}|准确|规范/u);
  assert.match(prompt.input, /旧标题/u);
  assert.equal(typeof prompt.system, 'string');
});

test('a failed title call leaves the evaluation watermark untouched so it retries', async () => {
  // The watermark is what makes the next prompt skip "already evaluated" work.
  // A failure must not advance it, or the retry never happens.
  const evaluations = new Map();
  const attempted = [];
  const runtime = createTitleRuntime({
    config,
    pattern,
    ctx: {
      sessionTitle: { get: () => undefined },
      llm: {
        async prepareCall(callConfig) {
          return {
            config: callConfig,
            // eslint-disable-next-line require-yield
            async *stream() { throw Object.assign(new Error('provider exploded'), { code: 'provider-failure' }); },
          };
        },
      },
      get: () => undefined,
    },
    state: { note: () => {}, record: () => {} },
    signal: new AbortController().signal,
    roleProbe: { ensure: async () => {} },
    readInstructions: undefined,
    providerId: 'session-title-template',
    bookkeeping: { forcedRefreshes: new Set(), activeRetitles: new Map(), lastEvaluations: evaluations },
  });
  const req = {
    session: {
      id: 'S-fail',
      header: { createdAt: Date.UTC(2026, 10, 24) },
      append: (type, data) => attempted.push({ type, data }),
      requestHeader: () => ({ config: { provider: 'primary', model: 'm' } }),
    },
    messages: [{ seq: 1, text: '修复登录超时' }],
    signal: new AbortController().signal,
  };
  await assert.rejects(() => runtime.generate(req));
  assert.equal(evaluations.get('S-fail'), undefined, 'a failed call must not record progress');
});

test('a successful call records how far it evaluated', async () => {
  const evaluations = new Map();
  const runtime = createTitleRuntime({
    config,
    pattern,
    ctx: {
      sessionTitle: { get: () => undefined },
      llm: {
        async prepareCall(callConfig) {
          return {
            config: callConfig,
            async *stream() {
              yield { type: 'text-delta', index: 0, text: '[1124][修复] 修复登录超时' };
              yield { type: 'finish', reason: { kind: 'stop' } };
            },
          };
        },
      },
      get: () => undefined,
    },
    state: { note: () => {}, record: () => {} },
    signal: new AbortController().signal,
    roleProbe: { ensure: async () => {} },
    readInstructions: undefined,
    providerId: 'session-title-template',
    bookkeeping: { forcedRefreshes: new Set(), activeRetitles: new Map(), lastEvaluations: evaluations },
  });
  const req = {
    session: {
      id: 'S-ok',
      header: { createdAt: Date.UTC(2026, 10, 24) },
      append: () => {},
      requestHeader: () => ({ config: { provider: 'primary', model: 'm' } }),
    },
    messages: [{ seq: 1, text: '修复登录超时' }],
    signal: new AbortController().signal,
  };
  const result = await runtime.generate(req);
  assert.equal(result.title, '[1124][修复] 修复登录超时');
  assert.deepEqual(evaluations.get('S-ok'), { seq: 1, count: 1 });
});
