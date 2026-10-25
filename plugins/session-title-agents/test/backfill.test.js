import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backfillTitles } from '../lib/backfill.js';
import { resolveConfig } from '../lib/config.js';
import { compileTitlePattern } from '../lib/title.js';
const createdAt = Date.UTC(2026, 9, 25, 0);
const title = '[1025][修复] 修复登录失败';
function setup({ pinned = false, canonical = false, interrupted = false, failFlush = false, noWriter = false, forced = false } = {}) {
  const events = [];
  if (pinned || canonical) events.push({ type: 'session/title', data: { title, source: { kind: pinned ? 'user' : 'provider' } } });
  if (interrupted) events.push({ type: 'turn/start', data: {} });
  const config = resolveConfig({ backfill: { enabled: true, ...(forced ? { retitle: [{ id: 's', hint: 'change title' }] } : {}) } });
  const pattern = compileTitlePattern(config.template, config.types.map(t => t.key));
  let resumed = 0, disposed = 0, markers = 0, flushed = false;
  const state = { read: async () => ({ backfilled: [], retitled: {} }), markBackfilled: async () => { assert.equal(flushed, true); markers++; }, markRetitled: async () => { assert.equal(flushed, true); markers++; }, note() {} };
  const session = { id: 's', header: { createdAt } };
  const agents = { get() {}, async resume() { resumed++; return { agent: { session }, dispose: async () => { disposed++; } }; } };
  const query = { listSessions: async () => [{ header: { id: 's', createdAt } }], readSession: async () => ({ session: { id: 's', createdAt }, events }) };
  const ctx = { get: k => k === 'agents' ? agents : query, sessions: { get() {}, flush: async () => { if (failFlush) throw new Error('disk failed'); flushed = true; return !noWriter; } }, sessionTitle: { get() {}, refresh: async () => ({ title, source: { kind: 'provider' } }) } };
  const controller = new AbortController();
  return { ctx, args: { config, state, signal: controller.signal, titleOptions: date => ({ pattern, date, template: config.template, types: config.types }), activeRetitles: new Map() }, counts: () => ({ resumed, disposed, markers }), controller, query };
}
test('skipped pinned or canonical or interrupted sessions are never resumed', async () => {
  for (const option of [{ pinned: true, forced: true }, { canonical: true }, { interrupted: true }]) {
    const f = setup(option); const result = await backfillTitles(f.ctx, f.args);
    assert.equal(result.skipped, 1); assert.deepEqual(f.counts(), { resumed: 0, disposed: 0, markers: 0 });
  }
});
test('failed flush leaves no success marker and disposes its resumed handle', async () => {
  const f = setup({ failFlush: true }); const result = await backfillTitles(f.ctx, f.args);
  assert.equal(result.failed, 1); assert.deepEqual(f.counts(), { resumed: 1, disposed: 1, markers: 0 });
});
test('no durable writer is not treated as persisted success', async () => {
  const f = setup({ noWriter: true }); const result = await backfillTitles(f.ctx, f.args);
  assert.equal(result.failed, 1); assert.equal(f.counts().markers, 0);
});
test('successful persistence precedes markers and owned agent disposal', async () => {
  const f = setup(); const result = await backfillTitles(f.ctx, f.args);
  assert.equal(result.updated, 1); assert.deepEqual(f.counts(), { resumed: 1, disposed: 1, markers: 1 });
});
test('backfill cancellation stops before resuming or marking', async () => {
  const f = setup(); f.query.readSession = async () => { f.controller.abort(); return { session: { createdAt }, events: [] }; };
  await assert.rejects(backfillTitles(f.ctx, f.args), e => e.name === 'AbortError');
  assert.equal(f.counts().resumed, 0); assert.equal(f.counts().markers, 0);
});
