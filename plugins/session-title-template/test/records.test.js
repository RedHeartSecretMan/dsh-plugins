import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'session-title-template-record-'));
after(async () => { await rm(scratch, { recursive: true, force: true }); });

const { createStateStore } = await import('../lib/state.js');

/** Build a store in its own directory so specs cannot leak records into each other. */
let storeCount = 0;
const store = () => createStateStore({ directory: join(scratch, `spec-${(storeCount += 1)}`) });

test('a structured record is readable back as structured data', async () => {
  const state = store();
  state.record({ kind: 'title-call-failed', route: 'p/m', attempt: 1, category: 'timeout' });
  await state.idle();
  const recent = await state.recentRecords();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].kind, 'title-call-failed');
  assert.equal(recent[0].route, 'p/m');
  assert.equal(recent[0].attempt, 1);
  assert.equal(recent[0].category, 'timeout');
  assert.ok(Number.isFinite(recent[0].at), 'records carry a timestamp');
});

test('records of one kind can be filtered and bounded', async () => {
  const state = store();
  for (let index = 0; index < 5; index += 1) {
    state.record({ kind: 'role-probe', route: 'p/m', verdict: 'unsupported', attempt: index });
  }
  state.record({ kind: 'title-call-failed', route: 'p/m', attempt: 9, category: 'timeout' });
  await state.idle();
  const probes = await state.recentRecords({ kind: 'role-probe', limit: 2 });
  assert.equal(probes.length, 2);
  assert.deepEqual(probes.map(entry => entry.attempt), [3, 4]);
  const failed = await state.recentRecords({ kind: 'title-call-failed' });
  assert.equal(failed.length, 1);
});

test('an oversized field is truncated instead of growing the log without bound', async () => {
  const state = store();
  state.record({ kind: 'role-probe', route: 'x'.repeat(5000), verdict: 'unsupported' });
  await state.idle();
  const [entry] = await state.recentRecords();
  assert.ok(entry.route.length <= 200, 'long values are truncated');
});

test('a nested state directory is created rather than treated as unreadable', async () => {
  const nested = join(scratch, 'absent', 'deeper');
  const state = createStateStore({ directory: nested });
  state.record({ kind: 'role-probe', route: 'p/m', verdict: 'supported' });
  await state.idle();
  assert.equal((await state.recentRecords()).length, 1);
});

test('records are written atomically enough that a corrupt line is skipped, not fatal', async () => {
  const dir = await mkdtemp(join(scratch, 'corrupt-'));
  const state = createStateStore({ directory: dir });
  state.record({ kind: 'role-probe', route: 'p/m', verdict: 'supported' });
  await state.idle();
  await writeFile(join(dir, 'diagnostics.jsonl'), `${await readFile(join(dir, 'diagnostics.jsonl'), 'utf8')}{ not json\n`, 'utf8');
  const entries = await state.recentRecords();
  assert.equal(entries.length, 1, 'the corrupt line is ignored');
  assert.equal(entries[0].verdict, 'supported');
});

test('records survive in the plugin state directory as JSON lines', async () => {
  const fresh = await mkdtemp(join(scratch, 'jsonl-'));
  const state = createStateStore({ directory: fresh });
  state.record({ kind: 'role-probe', route: 'p/m', verdict: 'supported' });
  await state.idle();
  const raw = await readFile(join(fresh, 'diagnostics.jsonl'), 'utf8');
  const line = raw.trim().split('\n').at(-1);
  assert.deepEqual(JSON.parse(line).kind, 'role-probe');
});
