import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ensureManagedFfmpeg, extractTarFile, managedPlatformKey } from '../lib/managed-ffmpeg.js';

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000755\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.write('        ', 148, 'ascii');
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  return header;
}

function tarWithFile(name, data) {
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([tarHeader(name, data.length), padded, Buffer.alloc(1024)]);
}

test('extractTarFile reads a regular npm tar member', () => {
  const tar = tarWithFile('package/ffmpeg', Buffer.from('binary'));
  const found = extractTarFile(tar, (name) => path.posix.basename(name) === 'ffmpeg');
  assert.equal(found.toString(), 'binary');
  assert.equal(extractTarFile(tar, () => false), undefined);
});

test('managedPlatformKey only accepts pinned platforms', () => {
  assert.equal(managedPlatformKey('win32', 'x64'), 'win32-x64');
  assert.equal(managedPlatformKey('freebsd', 'x64'), undefined);
});

test('ensureManagedFfmpeg reuses an already installed managed pair', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'managed-ffmpeg-'));
  try {
    await writeFile(path.join(root, 'ffmpeg'), 'binary');
    await writeFile(path.join(root, 'ffprobe'), 'binary');
    const result = await ensureManagedFfmpeg({ root, platform: 'linux', arch: 'x64', fetchImpl: async () => { throw new Error('must not download'); } });
    assert.equal(result.ffmpegPath, path.join(root, 'ffmpeg'));
    assert.equal(result.ffprobePath, path.join(root, 'ffprobe'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureManagedFfmpeg rejects unsupported platforms before downloading', async () => {
  await assert.rejects(
    ensureManagedFfmpeg({ platform: 'freebsd', arch: 'x64', fetchImpl: async () => { throw new Error('must not download'); } }),
    { code: 'VIDEO_FFMPEG_UNSUPPORTED' },
  );
});
