import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { hostModuleMtimes, processStartedAt, staleModule } = await import('../lib/build-info.js');

test('process start is derived from the uptime, not from the module load', () => {
  assert.equal(processStartedAt(1_000_000, 60), 940_000);
  assert.equal(processStartedAt(1_000_000, 0), 1_000_000);
});

test('a module newer than the process is reported, within a one-second grace', () => {
  const startedAt = 1_000_000;
  assert.equal(staleModule(startedAt, {}), undefined, 'no modules means nothing to compare');
  assert.equal(staleModule(startedAt, { 'index.js': startedAt - 5000 }), undefined, 'older code is current');
  assert.equal(staleModule(startedAt, { 'index.js': startedAt + 400 }), undefined, 'fs timestamp granularity is a grace, not staleness');
  assert.equal(staleModule(startedAt, { 'index.js': startedAt + 5000 }), 'index.js');
});

test('the newest stale module wins, and non-finite stamps are ignored', () => {
  const startedAt = 1_000_000;
  const stale = staleModule(startedAt, {
    'lib/a.js': startedAt + 3000,
    'lib/b.js': startedAt + 9000,
    'lib/c.js': Number.NaN,
  });
  assert.equal(stale, 'lib/b.js');
});

test('host module mtimes cover index.js, lib/*.js and nested lib directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stt-build-info-'));
  try {
    await writeFile(join(root, 'index.js'), '// entry\n');
    await mkdir(join(root, 'lib', 'title'), { recursive: true });
    await writeFile(join(root, 'lib', 'config.js'), '// lib\n');
    await writeFile(join(root, 'lib', 'title', 'text.js'), '// nested\n');
    await writeFile(join(root, 'client.js'), '// client half\n');
    const mtimes = hostModuleMtimes(root);
    assert.deepEqual(Object.keys(mtimes).sort(), ['index.js', 'lib/config.js', 'lib/title/text.js']);
    for (const value of Object.values(mtimes)) assert.ok(Number.isFinite(value));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
