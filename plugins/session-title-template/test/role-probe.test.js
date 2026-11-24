import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoleProbe, isProbeMatch, probeKey, PROBE_TOKEN } from '../lib/role-probe.js';

const route = { provider: 'local', model: 'flash' };
const other = { provider: 'local', model: 'big' };
const stop = () => ({ type: 'finish', reason: { kind: 'stop' } });

/** Build a plugin context whose stream replays one scripted behaviour per call. */
function fixture({ behaviours = [PROBE_TOKEN], disabled = false } = {}) {
  const notes = [];
  const calls = [];
  let index = 0;
  const controller = new AbortController();
  const ctx = {
    llm: {
      async prepareCall(config) {
        return { config, stream: options => this.stream(options) };
      },
      async *stream(options) {
        const behaviour = behaviours[Math.min(index, behaviours.length - 1)];
        index += 1;
        calls.push(options);
        if (behaviour instanceof Error) throw behaviour;
        yield { type: 'text-delta', index: 0, text: behaviour };
        yield stop();
      },
    },
  };
  const probe = createRoleProbe({
    ctx,
    config: { timeoutMs: 60_000, roleProbe: { enabled: !disabled } },
    note: line => notes.push(line),
    signal: controller.signal,
  });
  return { probe, notes, calls, controller, request: { session: { id: 'probe-session' } } };
}

test('the probe token is matched exactly, tolerating wrapping emphasis', () => {
  assert.equal(isProbeMatch(PROBE_TOKEN), true);
  assert.equal(isProbeMatch(`  ${PROBE_TOKEN}  `), true);
  assert.equal(isProbeMatch(`**${PROBE_TOKEN}**`), true);
  assert.equal(isProbeMatch(`${PROBE_TOKEN}\nTrailing commentary`), true);
  assert.equal(isProbeMatch(`好的，${PROBE_TOKEN}`), false);
  assert.equal(isProbeMatch('Please tell me your question.'), false);
  assert.equal(isProbeMatch(''), false);
});

test('one route key combines provider and model', () => {
  assert.notEqual(probeKey(route), probeKey(other));
  assert.equal(probeKey({ provider: 'local' }), undefined);
});

test('a matching reply records system support for that route', async () => {
  const f = fixture();
  assert.equal(await f.probe.ensure(route, f.request), 'supported');
  assert.equal(f.probe.verdictOf(route)?.verdict, 'supported');
  assert.deepEqual(f.notes, ['role-probe route=local/flash result=supported']);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].purpose, 'session-title-role-probe');
});

test('an unrelated reply records that the endpoint drops the instruction', async () => {
  const f = fixture({ behaviours: ['Please tell me your question.'] });
  assert.equal(await f.probe.ensure(route, f.request), 'unsupported');
  assert.deepEqual(f.notes, ['role-probe route=local/flash result=unsupported']);
});

test('a settled verdict is reused instead of probing twice', async () => {
  const f = fixture();
  await f.probe.ensure(route, f.request);
  await f.probe.ensure(route, f.request);
  assert.equal(f.calls.length, 1);
  const unknown = fixture({ behaviours: [new Error('socket hang up')] });
  await unknown.probe.ensure(other, unknown.request);
  assert.equal(unknown.probe.verdictOf(other)?.verdict, undefined, 'transport failure must not settle a verdict');
});

test('concurrent callers share one in-flight probe', async () => {
  const f = fixture();
  const results = await Promise.all([
    f.probe.ensure(route, f.request),
    f.probe.ensure(route, f.request),
    f.probe.ensure(route, f.request),
  ]);
  assert.deepEqual(results, ['supported', 'supported', 'supported']);
  assert.equal(f.calls.length, 1);
});

test('transport failures stay undecided and stop after the attempt ceiling', async () => {
  const f = fixture({ behaviours: [new Error('socket hang up')] });
  assert.equal(await f.probe.ensure(route, f.request), 'unknown');
  assert.equal(f.probe.verdictOf(route)?.verdict, undefined);
  assert.match(f.notes[0], /result=unknown attempt=1/u);
  await f.probe.ensure(route, f.request);
  await f.probe.ensure(route, f.request);
  assert.equal(f.calls.length, 3, 'probing stops at the ceiling');
  assert.equal(await f.probe.ensure(route, f.request), 'unknown');
  assert.equal(f.calls.length, 3);
});

test('the probe can be disabled by configuration', async () => {
  const f = fixture({ disabled: true });
  assert.equal(await f.probe.ensure(route, f.request), undefined);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.notes, []);
});

test('cancellation during the stream stays unknown rather than unsupported', async () => {
  const f = fixture();
  const pending = f.probe.ensure(route, f.request);
  f.controller.abort(new Error('plugin disposed'));
  await pending.catch(() => {});
  assert.equal(f.probe.verdictOf(route)?.verdict, undefined);
});

test('the interface is small and names what callers actually ask', () => {
  const f = fixture();
  // `ensure` starts work, `verdictOf` reads the answer, `drained` is the one
  // lifecycle call the owner needs: the plugin must drain before aborting its
  // lifetime, or an in-flight verdict is cancelled instead of logged.
  assert.deepEqual(Object.keys(f.probe).sort(), ['drained', 'ensure', 'verdictOf']);
});

test('a verdict that was already settled is reused by ensure', async () => {
  const f = fixture();
  await f.probe.ensure(route, f.request);
  f.probe.ensure(route, f.request);
  await f.probe.drained();
  assert.equal(f.calls.length, 1, 'a settled route is never probed twice');
});

test('a settled verdict reports the session that was being named', async () => {
  const verdicts = [];
  const ctx = {
    llm: {
      async prepareCall(config) { return { config, stream: options => this.stream(options) }; },
      async *stream() {
        yield { type: 'text-delta', index: 0, text: PROBE_TOKEN };
        yield stop();
      },
    },
  };
  const probe = createRoleProbe({
    ctx,
    config: { timeoutMs: 60_000, roleProbe: { enabled: true } },
    note: () => {},
    onVerdict: verdict => verdicts.push(verdict),
    signal: new AbortController().signal,
  });
  await probe.ensure(route, { session: { id: 'S-42' } });
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].sessionId, 'S-42', 'the verdict names the session it belongs to');
  assert.equal(verdicts[0].verdict, 'supported');
});
