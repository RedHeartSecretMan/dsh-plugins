import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { ffmpegCandidates, parseCapabilities, probeFfmpeg, resolveFfmpeg } from '../lib/ffmpeg.js';

const FILTERS = `
 Filters:
  T.. tile             Tile several frames together.
  ... scale            Scale the input video size.
  ... pad              Pad the input video.
`;

const FORMATS = `
 File formats:
  DE image2           image2 sequence
  DE concat           concatenated media
`;

const ENCODERS = `
 Encoders:
  V..... mjpeg          MJPEG (Motion JPEG)
`;

function fakeRun({ capable = true, ffprobe = true } = {}) {
  return async (command, args) => {
    if (args.includes('-version')) {
      if (command.includes('ffprobe')) {
        if (!ffprobe) throw new Error('ffprobe missing');
        return { stdout: 'ffprobe version 7.1\n' };
      }
      return { stdout: 'ffmpeg version 7.1\n' };
    }
    if (args.includes('-filters')) return { stdout: capable ? FILTERS : ' Filters:\n' };
    if (args.includes('-formats')) return { stdout: FORMATS };
    if (args.includes('-encoders')) return { stdout: capable ? ENCODERS : ' Encoders:\n' };
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
}

test('parseCapabilities recognizes the compose features', () => {
  const caps = parseCapabilities({
    version: { stdout: 'ffmpeg version 7.1.2\n' },
    filters: { stdout: FILTERS },
    formats: { stdout: FORMATS },
    encoders: { stdout: ENCODERS },
  });
  assert.equal(caps.version, '7.1.2');
  assert.deepEqual(caps.filters, { tile: true, scale: true, pad: true });
  assert.deepEqual(caps.demuxers, { image2: true, concat: true });
  assert.equal(caps.encoders.mjpeg, true);
});

test('probeFfmpeg accepts a complete build and rejects an incomplete one', async () => {
  const good = await probeFfmpeg({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, { run: fakeRun() });
  assert.equal(good.capable, true);
  assert.equal(good.version, '7.1');

  const bad = await probeFfmpeg({ ffmpegPath: 'ffmpeg-incomplete', ffprobePath: 'ffprobe' }, { run: fakeRun({ capable: false }) });
  assert.equal(bad.capable, false);
});

test('resolveFfmpeg returns the first capable candidate', async () => {
  const resolved = await resolveFfmpeg({
    storyboard: { ffmpegPath: 'ffmpeg' },
    env: {},
    run: fakeRun(),
  });
  assert.equal(resolved.capable, true);
  assert.equal(resolved.ffmpegPath, 'ffmpeg');
});

test('explicit candidates are authoritative and never silently replaced', async () => {
  await assert.rejects(
    resolveFfmpeg({
      storyboard: { ffmpegPath: 'missing-explicit-ffmpeg' },
      env: {},
      run: fakeRun(),
    }),
    { code: 'VIDEO_FFMPEG_UNSUPPORTED' },
  );
});

test('candidate discovery includes DSH_HOME tools ahead of the bare command', () => {
  const result = ffmpegCandidates({
    storyboard: {},
    env: { DSH_HOME: '/tmp/dsh-home' },
    platform: 'linux',
  });
  assert.equal(result.explicit, false);
  assert.ok(result.pairs.some((pair) => pair.ffmpegPath === path.join('/tmp/dsh-home', 'tools', 'ffmpeg', 'bin', 'ffmpeg')));
  assert.equal(result.pairs.at(-1).ffmpegPath, 'ffmpeg');
});

test('a PATH-installed Windows FFmpeg is probed instead of skipped as missing', async () => {
  // The generated bare name on win32 is `ffmpeg.exe`, which `existsSync` cannot
  // resolve. Regression: it used to be rejected as "not found", so a capable
  // local build was never used and a managed copy was downloaded instead.
  const candidates = ffmpegCandidates({ storyboard: {}, env: {}, platform: 'win32' });
  assert.equal(candidates.pairs.at(-1).ffmpegPath, 'ffmpeg.exe');
  assert.equal(candidates.pairs.at(-1).ffprobePath, 'ffprobe.exe');

  let managedCalls = 0;
  const resolved = await resolveFfmpeg({
    env: {},
    platform: 'win32',
    run: fakeRun(),
    managed: async () => {
      managedCalls += 1;
      throw new Error('a capable local FFmpeg must not trigger a managed download');
    },
  });
  assert.equal(resolved.capable, true);
  assert.equal(resolved.ffmpegPath, 'ffmpeg.exe');
  assert.equal(resolved.ffprobePath, 'ffprobe.exe');
  assert.equal(managedCalls, 0);
});
