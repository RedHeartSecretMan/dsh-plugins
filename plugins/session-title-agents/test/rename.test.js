import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerRenameTool } from '../lib/rename.js';

function fixture(persisted = true) {
  const session = { id: 'owned' };
  let tool, title, writes = 0, flushes = 0;
  const ctx = {
    tools: { register(value) { tool = value; } },
    sessions: { get(id) { return id === session.id ? session : undefined; }, async flush(value) { assert.equal(value, session); flushes++; return persisted; } },
    sessionTitle: {
      get(value) { assert.equal(value, session); return title; },
      rename(value, text) { assert.equal(value, session); writes++; return title = { title: text.trim(), source: { kind: 'user' }, eventSeq: writes }; },
    },
  };
  registerRenameTool(ctx, definition => definition);
  return { ctx, tool, session, exec: { agent: { session }, signal: new AbortController().signal }, get writes() { return writes; }, get flushes() { return flushes; } };
}

test('rename targets only the owning live session and returns the accepted pinned title', async () => {
  const f = fixture();
  const result = await f.tool.execute({ title: '  [1019][探索] Codex 降智路由核查  ' }, f.exec);
  assert.deepEqual(result, { title: '[1019][探索] Codex 降智路由核查', persisted: true });
  assert.equal(f.writes, 1); assert.equal(f.flushes, 1);
  assert.deepEqual(Object.keys(f.tool.parameters), ['title']);
  assert.equal(f.tool.isConcurrencySafe, undefined);
});
test('rename refuses non-agent, stale session, blank title and forged target', async () => {
  const f = fixture();
  for (const [args, exec] of [
    [{ title: 'valid' }, {}],
    [{ title: 'valid' }, { agent: { session: { id: 'owned' } } }],
    [{ title: ' ' }, f.exec],
    [{ title: 'valid', sessionId: 'someone-else' }, f.exec],
  ]) await assert.rejects(f.tool.execute(args, exec));
  assert.equal(f.writes, 0); assert.equal(f.flushes, 0);
});
test('cancelled rename does not mutate or persist', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.tool.execute({ title: 'valid' }, { ...f.exec, signal: controller.signal }), e => e.name === 'AbortError');
  assert.equal(f.writes, 0);
});
test('same pinned title is idempotent but still confirms persistence', async () => {
  const f = fixture();
  await f.tool.execute({ title: 'same' }, f.exec);
  await f.tool.execute({ title: 'same' }, f.exec);
  assert.equal(f.writes, 1); assert.equal(f.flushes, 2);
});
test('refresh is caller-owned and confirms persistence of the regenerated snapshot', async () => {
  const f = fixture(); const registered = new Map();
  f.ctx.tools.register = tool => registered.set(tool.name, tool);
  const accepted = { title: 'generated', source: { kind: 'provider' }, eventSeq: 12 };
  registerRenameTool(f.ctx, value => value, async (session, signal) => {
    assert.equal(session, f.session); assert.equal(signal, f.exec.signal);
    f.ctx.sessionTitle.get = () => accepted;
    return accepted;
  });
  const tool = registered.get('refresh_current_session_title');
  assert.deepEqual(await tool.execute({}, f.exec), { title: 'generated', persisted: true });
  assert.equal(f.flushes, 1);
  await assert.rejects(tool.execute({ sessionId: 'other' }, f.exec));
  await assert.rejects(tool.execute({}, {}));
});
test('refresh with no eligible input cannot claim success', async () => {
  const f = fixture(); let refreshTool;
  f.ctx.tools.register = value => { if (value.name === 'refresh_current_session_title') refreshTool = value; };
  registerRenameTool(f.ctx, value => value, async () => undefined);
  await assert.rejects(refreshTool.execute({}, f.exec), /No eligible/);
  assert.equal(f.flushes, 0);
});

test('a throwing durability listener reports a partial change without leaking its message', async () => {
  const f = fixture();
  f.ctx.sessions.flush = async () => { throw new Error('private disk detail'); };
  await assert.rejects(f.tool.execute({ title: 'changed' }, f.exec), error => {
    assert.match(error.message, /changed in memory.*persistence/);
    assert.doesNotMatch(error.message, /private disk detail/);
    return true;
  });
  assert.equal(f.writes, 1);
});

test('failed flush never reports durable success or duplicates the rename on retry', async () => {
  const f = fixture(false);
  await assert.rejects(f.tool.execute({ title: 'same' }, f.exec), /changed in memory.*persistence/);
  await assert.rejects(f.tool.execute({ title: 'same' }, f.exec), /changed in memory.*persistence/);
  assert.equal(f.writes, 1); assert.equal(f.flushes, 2);
});
