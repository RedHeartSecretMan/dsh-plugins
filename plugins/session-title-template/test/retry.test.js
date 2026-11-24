import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'session-title-template-retry-'));
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
const { describeTitleFailure, isRetryableTitleFailure } = await import('../lib/run.js');

const LOG_FILE = join(scratch, 'state', 'session-title-template', 'backfill.log');
const title = '[1026][修复] 排查登录超时';

/** Read diagnostic lines written by this suite's plugin activations. */
async function diagnostics() {
  try {
    return (await readFile(LOG_FILE, 'utf8')).split('\n').filter(line => line !== '');
  } catch {
    return [];
  }
}

const stop = () => ({ type: 'finish', reason: { kind: 'stop' } });

/**
 * Build a plugin activation whose title stream replays `behaviours` per call.
 * A string behaves like a good model reply; an Error is thrown mid-stream.
 */
let fixtures = 0;
function fixture({ snapshot, behaviours = [title], probeBehaviours = ['unrelated reply'], createdAt = Date.UTC(2026, 9, 26, 2, 0) } = {}) {
  let provider;
  const calls = [], effects = [];
  let call = 0;
  let probeCall = 0;
  const sessionId = `retry-fixture-${(fixtures += 1)}`;
  const ctx = {
    effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') effects.push(cleanup); return cleanup; },
    inject(services, callback) { if (services.every(service => ctx[service])) callback(ctx); },
    logger: { info() {}, warn() {}, debug() {} }, get() {},
    sessionTitle: { register(value) { provider = value; }, get() { return snapshot; } },
    sessions: { get() {} }, sessionProjections: { stateOf() {} },
    llm: {
      async prepareCall(config, signal, select) {
        const controls = select ? select(config, { reasoning: { efforts: [{ id: 'low' }] } }) : config;
        return { config: controls, stream: options => this.stream(options) };
      },
      async *stream(options) {
        // The role probe is a separate request kind: replay title behaviours only
        // for title calls so probe traffic cannot consume a scripted reply.
        const probing = options?.purpose === 'session-title-role-probe';
        const queue = probing ? probeBehaviours : behaviours;
        const cursor = probing ? probeCall : call;
        if (probing) probeCall += 1; else call += 1;
        const behaviour = queue[Math.min(cursor, queue.length - 1)];
        calls.push(options);
        if (behaviour instanceof Error) throw behaviour;
        yield { type: 'text-delta', index: 0, text: behaviour };
        yield stop();
      },
    },
  };
  const session = {
    id: sessionId,
    append() {},
    header: { createdAt },
    requestHeader: () => ({ config: { provider: 'primary', model: 'old-model' } }),
  };
  const request = {
    session,
    messages: [{ seq: 1, text: '修复登录超时' }, { seq: 2, text: '另外把超时时间调到 30 秒' }],
    signal: new AbortController().signal,
    ...(snapshot ? { currentTitle: snapshot } : {}),
  };
  return {
    calls,
    async generate(config = {}) { await apply(ctx, { roleProbe: { enabled: false }, ...config }); return provider.generate(request); },
    async dispose() { for (const fn of effects.reverse()) await fn(); },
  };
}

test('a transient failure is retried and the second attempt names the session', async () => {
  const before = (await diagnostics()).length;
  const f = fixture({
    snapshot: { title: '修复登录超时', source: { kind: 'fallback' }, messageSeqs: [1], eventSeq: 2 },
    behaviours: [Object.assign(new Error('route exploded'), { code: 'UPSTREAM_502' }), title],
  });
  try {
    assert.equal((await f.generate({ retryDelayMs: 0, agentsInstructions: { enabled: false } })).title, title);
    assert.equal(f.calls.length, 2);
  } finally { await f.dispose(); }
  const lines = (await diagnostics()).slice(before).filter(line => line.includes('title-call-failed'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /attempt 1\/3/);
  assert.match(lines[0], /UPSTREAM_502/);
  assert.match(lines[0], /provider-failure/);
  assert.doesNotMatch(lines[0], /route exploded/);
});

test('the final attempt is not retried and the last cause is rethrown', async () => {
  const before = (await diagnostics()).length;
  const f = fixture({
    snapshot: { title: '修复登录超时', source: { kind: 'fallback' }, messageSeqs: [1], eventSeq: 2 },
    behaviours: [new Error('first'), new Error('second'), new Error('third')],
  });
  try {
    await assert.rejects(f.generate({ retryDelayMs: 0, agentsInstructions: { enabled: false } }), /third/u);
    assert.equal(f.calls.length, 3);
  } finally { await f.dispose(); }
  const lines = (await diagnostics()).slice(before).filter(line => line.includes('title-call-failed'));
  assert.equal(lines.length, 3);
  assert.match(lines[2], /attempt 3\/3/);
});

test('a deterministic budget failure never spends a second attempt', async () => {
  const before = (await diagnostics()).length;
  const f = fixture({
    snapshot: { title: '修复登录超时', source: { kind: 'fallback' }, messageSeqs: [1], eventSeq: 2 },
    behaviours: [new Error('session-title-template: input byte budget exceeded')],
  });
  try {
    await assert.rejects(f.generate({ retryDelayMs: 0, agentsInstructions: { enabled: false } }), /budget exceeded/u);
    assert.equal(f.calls.length, 1);
  } finally { await f.dispose(); }
  const lines = (await diagnostics()).slice(before).filter(line => line.includes('title-call-failed'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /input-budget/);
});

test('a failed round revisits every route before retrying the first', async () => {
  const f = fixture({
    snapshot: { title: '修复登录超时', source: { kind: 'fallback' }, messageSeqs: [1], eventSeq: 2 },
    behaviours: [new Error('primary down'), new Error('backup down'), title],
  });
  try {
    const result = await f.generate({
      retryDelayMs: 0,
      backfill: { fallbackRoute: { provider: 'backup', model: 'backup-model' } },
      agentsInstructions: { enabled: false },
    });
    assert.equal(result.title, title);
    assert.deepEqual(f.calls.map(call => call.provider), ['primary', 'backup', 'primary']);
  } finally { await f.dispose(); }
});

test('retryAttempts is bounded by configuration', async () => {
  const f = fixture({
    snapshot: { title: '修复登录超时', source: { kind: 'fallback' }, messageSeqs: [1], eventSeq: 2 },
    behaviours: [new Error('flaky')],
  });
  try {
    await assert.rejects(f.generate({ retryAttempts: 1, retryDelayMs: 0, agentsInstructions: { enabled: false } }), /flaky/u);
    assert.equal(f.calls.length, 1);
  } finally { await f.dispose(); }
});

test('failure descriptions stay single-line and bounded', () => {
  const multi = Object.assign(new Error('第一行\n第二行\t tab'), { code: 'E_ONE' });
  const described = describeTitleFailure(multi, 2, 3);
  assert.doesNotMatch(described.text, /\n/u);
  assert.equal(described.text, 'attempt 2/3 E_ONE: provider-failure');
  assert.doesNotMatch(described.text, /第一行|第二行/u);

  const long = describeTitleFailure(new Error('x'.repeat(400)), 1, 3);
  assert.ok(long.text.length < 200);
  assert.match(long.text, /provider-failure$/u);
  assert.doesNotMatch(long.text, /x{20}/u);
});

test('only budget failures are classified as non-retryable', () => {
  assert.equal(isRetryableTitleFailure(new Error('session-title-template: input byte budget exceeded')), false);
  assert.equal(isRetryableTitleFailure(new Error('session-title-template: no input fits the configured byte budget')), false);
  assert.equal(isRetryableTitleFailure(new Error('session-title-template: title request timed out')), true);
  assert.equal(isRetryableTitleFailure(new Error('session-title-template: model output did not match the title template')), true);
});

test('role probing never delays or fails a title, even when the probe reply is wrong', async () => {
  const before = (await diagnostics()).length;
  const f = fixture({
    snapshot: { title: '修复登录超时', source: { kind: 'fallback' }, messageSeqs: [1], eventSeq: 2 },
    behaviours: [title, 'Please tell me your question.'],
  });
  try {
    // Opt back in: the shared fixture disables probing so title-call counts stay exact.
    assert.equal((await f.generate({ roleProbe: { enabled: true } })).title, title);
  } finally {
    // dispose drains detached probes and flushes the diagnostic log.
    await f.dispose();
  }
  const lines = (await diagnostics()).slice(before);
  assert.ok(lines.some(line => /role-probe route=primary\/old-model result=unsupported/u.test(line)), 'probe verdict is recorded');
  assert.equal(lines.filter(line => line.includes('title-call-failed')).length, 0);
});

test('failure reporting exposes the category as a field, not a parsed suffix', async () => {
  const { describeTitleFailure } = await import('../lib/run.js');
  const detail = describeTitleFailure(Object.assign(new Error('stream failed'), { code: 'E_X' }), 2, 3);
  assert.equal(typeof detail, 'object', 'the caller receives structured data');
  assert.equal(detail.category, 'stream-failure');
  assert.equal(detail.code, 'E_X');
  assert.equal(detail.attempt, 2);
  assert.equal(detail.text, 'attempt 2/3 E_X: stream-failure');
});
