import assert from 'node:assert/strict';
import { test } from 'node:test';

const { registerTitleCommands, TITLE_COMMAND_NAME } = await import('../lib/commands.js');
const { resolveConfig } = await import('../lib/config.js');

const config = resolveConfig({});

/**
 * Build a host context that records the registered command and lets a test
 * invoke its handler against one session.
 */
function fixture({ session = { id: 'S1' }, describe, refresh, rename, describeError } = {}) {
  const registered = [];
  const notes = [];
  const records = [];
  const calls = { refresh: [], rename: [] };
  // The service is the source of truth, so a successful pin must be visible
  // through `get()`: the command reads the title back before claiming success.
  let current = { title: '[1124][修复] 旧标题', source: { kind: 'provider' }, messageSeqs: [1] };
  const ctx = {
    sessionTitle: {
      get: () => current,
      rename: (target, title) => {
        calls.rename.push({ session: target.id, title });
        if (rename !== undefined) return rename(target, title);
        current = { title, eventSeq: 7, source: { kind: 'user' }, messageSeqs: [1] };
        return current;
      },
      async refresh(target) {
        calls.refresh.push(target.id);
        if (refresh !== undefined) return refresh(target);
        return { title: '[1124][修复] 新标题', source: { kind: 'provider' }, messageSeqs: [1], eventSeq: 9 };
      },
    },
    sessions: { flush: async () => true, get: id => (id === session.id ? session : undefined) },
    commands: { register: definition => { registered.push(definition); return () => {}; } },
  };
  registerTitleCommands(ctx, {
    config,
    state: { note: line => notes.push(line), record: entry => records.push(entry) },
    describe: describe ?? (async () => ({
      summary: '内置规则',
      builtin: { template: config.template, dateFormat: config.dateFormat, timezone: config.timezone, types: config.types.map(entry => entry.key), topicMaxChars: config.topicMaxChars },
      supplemental: { count: 0, sources: [] },
      title: { value: '[1124][修复] 旧标题', source: 'provider', pinned: false },
      lastFailure: null,
      probe: null,
    })),
    refresh: async (target, signal) => ctx.sessionTitle.refresh(target, signal),
    describeError,
  });
  assert.equal(registered.length, 1, 'exactly one command is registered');
  const command = registered[0];
  /** Run one invocation with the given input line. */
  const run = (rawInput, overrides = {}) => command.handler({
    agent: { session }, rawInput, attachments: [], signal: new AbortController().signal, ...overrides,
  });
  return { command, run, calls, notes, records, registered };
}

test('the command name is a lowercase slash name', () => {
  assert.equal(TITLE_COMMAND_NAME, 'title');
  assert.match(TITLE_COMMAND_NAME, /^[a-z][a-z0-9_-]*$/u);
});

test('the registration advertises the accepted verbs', () => {
  const f = fixture();
  assert.match(f.command.description, /标题/u);
  assert.equal(f.command.input.hint.includes('status'), true);
  assert.equal(f.command.input.hint.includes('pin'), true);
});

test('a bare invocation reports status without changing the title', async () => {
  const f = fixture();
  const result = await f.run('');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /内置规则/u);
  assert.deepEqual(f.calls.refresh, []);
  assert.deepEqual(f.calls.rename, []);
});

test('refresh regenerates the title and reports the accepted one', async () => {
  const f = fixture();
  const result = await f.run('refresh');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /新标题/u);
  assert.deepEqual(f.calls.refresh, ['S1']);
});

test('refresh reports a failure as an error result instead of throwing', async () => {
  const f = fixture({ refresh: async () => { throw new Error('no model route is available'); } });
  const result = await f.run('refresh');
  assert.equal(result.kind, 'error');
  // The executor writes this text into the durable session log, so it names a
  // category and points at the diagnostics instead of quoting the raw error.
  assert.doesNotMatch(result.text, /no model route/u, 'raw provider text must not reach the session log');
  assert.match(result.text, /类\u522b|category/u);
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].kind, 'title-command-failed');
  assert.equal(f.records[0].verb, 'refresh');
});

test('refresh without an eligible title says so', async () => {
  const f = fixture({ refresh: async () => undefined });
  const result = await f.run('refresh');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /消息|标题/u);
});

test('pin fixes the title through the official service', async () => {
  const f = fixture();
  const result = await f.run('pin [1124][文档] 我的标题');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /我的标题/u);
  assert.deepEqual(f.calls.rename, [{ session: 'S1', title: '[1124][文档] 我的标题' }]);
});

test('pin rejects an empty title through the parser', async () => {
  const f = fixture();
  const result = await f.run('pin');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /pin/u);
  assert.deepEqual(f.calls.rename, []);
});

test('auto unpins by regenerating, and says so', async () => {
  const f = fixture();
  const result = await f.run('auto');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /自动/u);
  assert.deepEqual(f.calls.refresh, ['S1'], 'unpinning is an explicit refresh');
});

test('an unknown verb is a usage error, not a crash', async () => {
  const f = fixture();
  const result = await f.run('frobnicate');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /status/u);
});

test('status degrades to a readable error when the snapshot cannot be built', async () => {
  const f = fixture({
    describe: async () => { throw new Error('snapshot unavailable'); },
  });
  const result = await f.run('status');
  assert.equal(result.kind, 'error');
  assert.doesNotMatch(result.text, /snapshot unavailable/u);
  assert.equal(f.records[0].verb, 'status');
});

test('the handler refuses to act without a live session', async () => {
  const f = fixture();
  const result = await f.run('refresh', { agent: { session: { id: 'OTHER' } } });
  assert.equal(result.kind, 'error');
  assert.deepEqual(f.calls.refresh, [], 'a foreign session is never retitled');
});
