import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDefaultRunner, createStoryboardBuilder } from '../lib/storyboard.js';

const PREFIX = 'session-video-intake: ';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const sha = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

function refFor(data, name = 'clip.mp4') {
  return { attachmentId: sha(data), name, bytes: data.length };
}

function probeJson({ duration = 20, width = 1920, height = 1080, hasAudio = true } = {}) {
  return JSON.stringify({
    format: { duration: String(duration) },
    streams: [
      { codec_type: 'video', width, height },
      ...(hasAudio ? [{ codec_type: 'audio' }] : []),
    ],
  });
}

function fixture(options = {}) {
  const {
    duration = 20,
    width = 1920,
    height = 1080,
    hasAudio = true,
    probeStdout,
    probeError,
    ffmpegError,
    failAt,
    tileErrorOnce = false,
    png = PNG,
  } = options;
  const calls = [];
  const probeInputs = [];
  let tempDirectory;
  let probeBytes;
  let frameIndex = 0;
  let tileFailures = 0;

  async function run(command, args, runOptions) {
    calls.push({ command, args: [...args], options: runOptions });
    if (command === 'ffprobe') {
      const input = args.at(-1);
      if (typeof input === 'string') probeInputs.push(input);
      if (typeof input === 'string' && !/^https?:/i.test(input)) {
        tempDirectory ??= path.dirname(input);
        probeBytes = await readFile(input);
      }
      if (failAt === 'probe' || probeError) {
        throw probeError ?? Object.assign(new Error('ffprobe failed'), { stderr: 'probe stderr: bad container' });
      }
      return { stdout: probeStdout ?? probeJson({ duration, width, height, hasAudio }) };
    }
    if (command !== 'ffmpeg') throw new Error(`unexpected command: ${command}`);
    const output = args.at(-1);
    if (typeof output !== 'string') throw new Error('ffmpeg call has no output path');
    tempDirectory ??= path.dirname(output);
    const tile = args.some((arg) => typeof arg === 'string' && arg.startsWith('tile='));
    if (tile && tileErrorOnce && args.includes('-pattern_type') && tileFailures++ === 0) {
      throw Object.assign(new Error('glob unsupported'), {
        stderr: "Pattern type 'glob' was selected but globbing is not supported by this libavformat build",
      });
    }
    if (ffmpegError || failAt === 'ffmpeg' || (failAt === 'frame' && !tile) || (failAt === 'tile' && tile)) {
      throw ffmpegError ?? Object.assign(new Error('ffmpeg failed'), { stderr: 'ffmpeg stderr: codec failure' });
    }
    if (tile) {
      await writeFile(output, png);
    } else {
      await writeFile(output, Buffer.from(`frame-${frameIndex}`));
      frameIndex += 1;
    }
    return { stdout: '' };
  }

  const builder = createStoryboardBuilder({
    run,
    resolveTools: options.resolveTools,
    cells: options.cells,
    cellEdge: options.cellEdge,
    timeoutMs: options.timeoutMs,
    sceneAware: options.sceneAware,
    scan: options.scan,
  });
  return {
    builder,
    calls,
    probeInputs,
    png,
    get tempDirectory() { return tempDirectory; },
    get probeBytes() { return probeBytes; },
  };
}

function attachmentsFor(data, { chunkSize = 7 } = {}) {
  const reads = [];
  return {
    reads,
    async *readFileStream(ref, signal) {
      reads.push({ ref, signal });
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        signal?.throwIfAborted?.();
        yield data.subarray(offset, offset + chunkSize);
      }
    },
  };
}

async function storyboardTempDirs() {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('session-video-storyboard-'))
    .map((entry) => entry.name)
    .sort();
}

const isTileCall = (call) => call.command === 'ffmpeg'
  && call.args.some((arg) => typeof arg === 'string' && arg.startsWith('tile='));

function framesOf(calls) {
  return calls.filter((call) => call.command === 'ffmpeg' && !isTileCall(call));
}

function tileOf(calls) {
  return calls.find((call) => isTileCall(call));
}

test('attachment source builds a verified storyboard and cleans up', async () => {
  const data = Buffer.from('fake-mp4-video-bytes-for-storyboard-tests');
  const ref = refFor(data, 'clip.mp4');
  const controller = new AbortController();
  const h = fixture({ duration: 20, width: 1920, height: 1080, hasAudio: true });
  const attachments = attachmentsFor(data, { chunkSize: 7 });
  const before = await storyboardTempDirs();

  const artifact = await h.builder.build({
    source: { kind: 'attachment', ref },
    name: 'clip.mp4',
    signal: controller.signal,
    attachments,
  });

  assert.deepEqual(artifact.png, PNG);
  assert.deepEqual(h.probeBytes, data, 'the written temporary file has the exact attachment bytes');
  assert.equal(h.probeInputs.length, 1);
  assert.equal(path.dirname(h.probeInputs[0]), h.tempDirectory);
  assert.equal(attachments.reads.length, 1);
  assert.equal(attachments.reads[0].ref, ref);
  assert.equal(attachments.reads[0].signal, controller.signal);

  assert.deepEqual(artifact.info, {
    duration: 20,
    width: 1920,
    height: 1080,
    hasAudio: true,
    cells: 5,
    cols: 3,
    rows: 2,
    planning: 'uniform',
    cuts: 0,
  });
  assert.deepEqual(artifact.sheet, { cellTimes: [2, 6, 10, 14, 18] });

  const lines = artifact.manifest.split('\n');
  assert.equal(lines.length, 7);
  assert.equal(
    lines[0],
    '视频分镜：clip.mp4；时长 00:20.00；3×2 网格（5 格）；按从左到右、从上到下阅读。',
  );
  assert.deepEqual(lines.slice(1, 6), [
    '第 1 格 = 00:00.00–00:04.00',
    '第 2 格 = 00:04.00–00:08.00',
    '第 3 格 = 00:08.00–00:12.00',
    '第 4 格 = 00:12.00–00:16.00',
    '第 5 格 = 00:16.00–00:20.00',
  ]);
  assert.equal(lines[6], '这是采样分镜，不是连续视频；细节请要求更高分辨率或指定时间段');

  const frames = framesOf(h.calls);
  assert.equal(frames.length, 5);
  assert.deepEqual(
    frames.map((call) => call.args[call.args.indexOf('-ss') + 1]),
    ['2.000', '6.000', '10.000', '14.000', '18.000'],
  );
  for (const call of frames) {
    const { args, options } = call;
    assert.equal(args[args.indexOf('-i') + 1], h.probeInputs[0]);
    assert.equal(args[args.indexOf('-frames:v') + 1], '1');
    assert.equal(args[args.indexOf('-vf') + 1], "scale='min(256,iw)':-2");
    assert.equal(args[args.indexOf('-q:v') + 1], '4');
    assert.match(args.at(-1), /frame-\d{3}\.jpg$/);
    assert.equal(path.dirname(args.at(-1)), h.tempDirectory);
    assert.equal(options.timeoutMs, 120000);
    assert.equal(options.signal, controller.signal);
  }

  const tile = tileOf(h.calls);
  assert.ok(tile, 'tile command expected');
  assert.deepEqual(tile.args, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'image2',
    '-pattern_type', 'glob',
    '-i', path.join(h.tempDirectory, '*.jpg'),
    '-vf', 'tile=3x2:padding=4:margin=4',
    '-frames:v', '1',
    '-update', '1',
    path.join(h.tempDirectory, 'storyboard.png'),
  ]);
  assert.equal(tile.options.timeoutMs, 120000);
  assert.equal(tile.options.signal, controller.signal);

  await assert.rejects(access(h.tempDirectory), (error) => error.code === 'ENOENT');
  assert.deepEqual(await storyboardTempDirs(), before, 'no temporary directory is left behind');
});

test('image2 sequence is the primary compose path when glob is not requested', async () => {
  const data = Buffer.from('image2-fallback-video');
  const h = fixture({
    duration: 10,
    resolveTools: async () => ({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', composeModes: ['image2'] }),
  });
  await h.builder.build({
    source: { kind: 'attachment', ref: refFor(data) },
    attachments: attachmentsFor(data),
  });
  const tile = tileOf(h.calls);
  assert.ok(tile);
  assert.ok(!tile.args.includes('-pattern_type'));
  assert.equal(tile.args[tile.args.indexOf('-start_number') + 1], '0');
  assert.equal(tile.args[tile.args.indexOf('-i') + 1], path.join(h.tempDirectory, 'frame-%03d.jpg'));
  assert.equal(tile.args[tile.args.indexOf('-update') + 1], '1');
});

test('a glob-unsupported failure retries once with image2 and caches the choice', async () => {
  const data = Buffer.from('glob-fallback-video');
  const h = fixture({ duration: 10, tileErrorOnce: true });
  await h.builder.build({
    source: { kind: 'attachment', ref: refFor(data) },
    attachments: attachmentsFor(data),
  });
  const tiles = h.calls.filter((call) => isTileCall(call));
  assert.equal(tiles.length, 2);
  assert.ok(tiles[0].args.includes('-pattern_type'));
  assert.ok(!tiles[1].args.includes('-pattern_type'));
  assert.equal(tiles[1].args[tiles[1].args.indexOf('-start_number') + 1], '0');
});

test('a SHA-256 mismatch is rejected before probing', async () => {
  const data = Buffer.from('real video bytes');
  const ref = { attachmentId: sha(Buffer.from('different bytes')), name: 'clip.mp4', bytes: data.length };
  const h = fixture();
  const attachments = attachmentsFor(data);
  const before = await storyboardTempDirs();

  await assert.rejects(
    h.builder.build({ source: { kind: 'attachment', ref }, name: 'clip.mp4', attachments }),
    (error) => {
      assert.equal(error.code, 'VIDEO_STORYBOARD_INVALID_SOURCE');
      assert.match(error.message, new RegExp(`^${PREFIX}`));
      return true;
    },
  );
  assert.equal(h.calls.length, 0, 'ffprobe must not run on a corrupt attachment');
  assert.equal(attachments.reads.length, 1);
  assert.deepEqual(await storyboardTempDirs(), before);
});

test('a byte-count mismatch is rejected before probing', async () => {
  const data = Buffer.from('real video bytes');
  const ref = { attachmentId: sha(data), name: 'clip.mp4', bytes: data.length + 1 };
  const h = fixture();
  const attachments = attachmentsFor(data);

  await assert.rejects(
    h.builder.build({ source: { kind: 'attachment', ref }, name: 'clip.mp4', attachments }),
    { code: 'VIDEO_STORYBOARD_INVALID_SOURCE' },
  );
  assert.equal(h.calls.length, 0);
});

test('URL sources are probed and sampled directly without reading attachments', async () => {
  const url = 'https://cdn.invalid/videos/clip.mp4';
  const controller = new AbortController();
  const h = fixture({ duration: 10, width: 640, height: 360, hasAudio: false });
  let reads = 0;
  const attachments = {
    async *readFileStream() {
      reads += 1;
      throw new Error('URL sources must not read attachments');
    },
  };

  const artifact = await h.builder.build({ source: { kind: 'url', url }, signal: controller.signal, attachments });

  assert.equal(reads, 0);
  assert.equal(h.probeInputs[0], url);
  assert.equal(h.probeBytes, undefined);
  assert.deepEqual(artifact.info, {
    duration: 10,
    width: 640,
    height: 360,
    hasAudio: false,
    cells: 4,
    cols: 2,
    rows: 2,
    planning: 'uniform',
    cuts: 0,
  });
  assert.deepEqual(artifact.sheet.cellTimes, [1.25, 3.75, 6.25, 8.75]);
  assert.match(artifact.manifest.split('\n')[0], /^视频分镜：clip\.mp4；时长 00:10\.00；2×2 网格（4 格）/);
  const frames = framesOf(h.calls);
  assert.equal(frames.length, 4);
  assert.ok(frames.every((call) => call.args[call.args.indexOf('-i') + 1] === url));
  assert.ok(frames.every((call) => call.options.signal === controller.signal));
  assert.ok(tileOf(h.calls));
  await assert.rejects(access(h.tempDirectory), (error) => error.code === 'ENOENT');
});

test('a probe without a usable duration fails with PROBE_FAILED and cleans up', async () => {
  const h = fixture({
    probeStdout: JSON.stringify({ format: {}, streams: [{ codec_type: 'video', width: 640, height: 360 }] }),
  });
  const attachments = attachmentsFor(Buffer.from('video'));
  const before = await storyboardTempDirs();

  await assert.rejects(
    h.builder.build({ source: { kind: 'attachment', ref: refFor(Buffer.from('video')) }, attachments }),
    (error) => {
      assert.equal(error.code, 'VIDEO_STORYBOARD_PROBE_FAILED');
      assert.match(error.message, new RegExp(`^${PREFIX}`));
      return true;
    },
  );
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].command, 'ffprobe');
  assert.ok(h.tempDirectory);
  await assert.rejects(access(h.tempDirectory), (error) => error.code === 'ENOENT');
  assert.deepEqual(await storyboardTempDirs(), before);
});

test('ffmpeg execution failures map to FAILED with bounded stderr and cause', async () => {
  const stderr = 'x'.repeat(6000);
  const thrown = Object.assign(new Error('frame extraction failed'), { code: 1, stderr });
  const h = fixture({ duration: 10, ffmpegError: thrown });
  const attachments = attachmentsFor(Buffer.from('video'));

  await assert.rejects(
    h.builder.build({ source: { kind: 'attachment', ref: refFor(Buffer.from('video')) }, attachments }),
    (error) => {
      assert.equal(error.code, 'VIDEO_STORYBOARD_FAILED');
      assert.match(error.message, new RegExp(`^${PREFIX}`));
      assert.ok(error.message.includes(stderr.slice(-4096)), 'message carries the tail stderr');
      assert.ok(!error.message.includes(stderr), 'stderr is bounded');
      assert.equal(error.cause, thrown);
      return true;
    },
  );
  assert.ok(h.tempDirectory);
  await assert.rejects(access(h.tempDirectory), (error) => error.code === 'ENOENT');
});

test('ENOENT from ffprobe or ffmpeg maps to UNAVAILABLE', async () => {
  for (const tool of ['probe', 'ffmpeg']) {
    const thrown = Object.assign(new Error(`spawn ${tool} ENOENT`), { code: 'ENOENT' });
    const h = fixture({
      duration: 8,
      probeError: tool === 'probe' ? thrown : undefined,
      ffmpegError: tool === 'ffmpeg' ? thrown : undefined,
    });
    const attachments = attachmentsFor(Buffer.from('video'));
    await assert.rejects(
      h.builder.build({ source: { kind: 'attachment', ref: refFor(Buffer.from('video')) }, attachments }),
      (error) => {
        assert.equal(error.code, 'VIDEO_STORYBOARD_UNAVAILABLE', tool);
        assert.match(error.message, new RegExp(`^${PREFIX}`));
        assert.equal(error.cause, thrown);
        return true;
      },
    );
    assert.ok(h.tempDirectory);
    await assert.rejects(access(h.tempDirectory), (error) => error.code === 'ENOENT');
  }
});

test('an already-aborted signal throws ABORTED before any work', async () => {
  const controller = new AbortController();
  controller.abort('test cancellation');
  const h = fixture();
  const attachments = attachmentsFor(Buffer.from('video'));
  const before = await storyboardTempDirs();

  await assert.rejects(
    h.builder.build({
      source: { kind: 'attachment', ref: refFor(Buffer.from('video')) },
      signal: controller.signal,
      attachments,
    }),
    (error) => {
      assert.equal(error.code, 'VIDEO_STORYBOARD_ABORTED');
      assert.match(error.message, new RegExp(`^${PREFIX}`));
      return true;
    },
  );
  assert.equal(h.calls.length, 0);
  assert.equal(attachments.reads.length, 0);
  assert.deepEqual(await storyboardTempDirs(), before);
});

test('cancellation during attachment read keeps the storyboard abort code', async () => {
  const controller = new AbortController();
  const data = Buffer.alloc(64, 7);
  const attachments = {
    async *readFileStream() {
      yield data.subarray(0, 7);
      controller.abort('test cancellation');
      yield data.subarray(7);
    },
  };
  const h = fixture();
  await assert.rejects(
    h.builder.build({
      source: { kind: 'attachment', ref: refFor(data) },
      signal: controller.signal,
      attachments,
    }),
    (error) => {
      assert.equal(error.code, 'VIDEO_STORYBOARD_ABORTED');
      assert.match(error.message, new RegExp(`^${PREFIX}`));
      return true;
    },
  );
});

test('cell count uses four as the floor and cells as the cap', async () => {
  const scenarios = [
    {
      duration: 2,
      cells: 9,
      expectedCells: 4,
      cols: 2,
      rows: 2,
      times: ['0.250', '0.750', '1.250', '1.750'],
      tile: 'tile=2x2:padding=4:margin=4',
    },
    {
      duration: 100,
      cells: 6,
      expectedCells: 6,
      cols: 3,
      rows: 2,
      times: ['8.333', '25.000', '41.667', '58.333', '75.000', '91.667'],
      tile: 'tile=3x2:padding=4:margin=4',
    },
  ];

  for (const scenario of scenarios) {
    const data = Buffer.from(`video-${scenario.duration}`);
    const h = fixture({ duration: scenario.duration, cells: scenario.cells });
    const artifact = await h.builder.build({
      source: { kind: 'attachment', ref: refFor(data) },
      name: 'clip.mp4',
      attachments: attachmentsFor(data),
    });
    assert.equal(artifact.info.cells, scenario.expectedCells);
    assert.equal(artifact.info.cols, scenario.cols);
    assert.equal(artifact.info.rows, scenario.rows);
    assert.deepEqual(artifact.sheet.cellTimes, scenario.times.map(Number));
    const frames = framesOf(h.calls);
    assert.equal(frames.length, scenario.expectedCells);
    assert.deepEqual(
      frames.map((call) => call.args[call.args.indexOf('-ss') + 1]),
      scenario.times,
    );
    const tile = tileOf(h.calls);
    assert.ok(tile);
    assert.ok(tile.args.includes(scenario.tile));
    assert.equal(artifact.manifest.split('\n').length, scenario.expectedCells + 2);
    await assert.rejects(access(h.tempDirectory), (error) => error.code === 'ENOENT');
  }
});

test('default runner resolves stdout', async () => {
  const run = createDefaultRunner();
  const { stdout } = await run(process.execPath, ['-e', 'process.stdout.write("storyboard-ok")'], { timeoutMs: 5000 });
  assert.equal(stdout, 'storyboard-ok');
});

test('default runner reports the tail of stderr and exit code', async () => {
  const stderr = 'e'.repeat(6000);
  const run = createDefaultRunner();
  await assert.rejects(
    run(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(stderr)}); process.exit(7);`], { timeoutMs: 5000 }),
    (error) => {
      assert.match(error.message, new RegExp(`^${PREFIX}`));
      assert.equal(error.code, 7);
      assert.equal(error.stderr, stderr.slice(-4096));
      assert.ok(error.message.includes(stderr.slice(-4096)));
      assert.ok(!error.message.includes(stderr));
      return true;
    },
  );
});

test('default runner terminates a timed-out process', async () => {
  const run = createDefaultRunner();
  const started = Date.now();
  await assert.rejects(
    run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 150 }),
    (error) => {
      assert.equal(error.code, 'ETIMEDOUT');
      assert.match(error.message, /timed out after 150ms/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000, 'timeout must not wait for the child to finish');
});

test('default runner terminates an aborted process', async () => {
  const run = createDefaultRunner();
  const controller = new AbortController();
  const running = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 5000,
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(running, (error) => {
      assert.equal(error.code, 'ABORT_ERR');
      assert.match(error.message, /was aborted/);
      return true;
    });
  } finally {
    clearTimeout(timer);
  }
});

test('default runner preserves ENOENT for the builder to map', async () => {
  const run = createDefaultRunner();
  await assert.rejects(
    run('session-video-storyboard-definitely-missing-tool', [], { timeoutMs: 5000 }),
    (error) => {
      assert.equal(error.code, 'ENOENT');
      assert.match(error.message, new RegExp(`^${PREFIX}`));
      return true;
    },
  );
});


test('scene-aware planning places cells on content segments', async () => {
  const cuts = [{ t: 4 }, { t: 9 }, { t: 15 }];
  const f = fixture({ duration: 20, sceneAware: true, scan: async () => cuts });
  const artifact = await f.builder.build({ source: { kind: 'url', url: 'https://example.test/clip.mp4' }, name: 'clip.mp4' });
  assert.equal(artifact.info.planning, 'scene');
  assert.equal(artifact.info.cuts, 3);
  assert.ok(artifact.info.cells >= 4 && artifact.info.cells <= 9);
  assert.equal(artifact.sheet.cellTimes.length, artifact.info.cells);
  const lines = artifact.manifest.split('\n');
  assert.equal(lines.length, artifact.info.cells + 2);
  assert.match(lines[0], /分镜/);
  assert.match(lines.at(-1), /场景切点/);
  for (const line of lines.slice(1, -1)) assert.match(line, /第 \d+ 格 = \d{2}:\d{2}\.\d{2}–\d{2}:\d{2}\.\d{2}/);
  const frameCalls = f.calls.filter((call) => call.command === 'ffmpeg' && call.args.includes('-ss'));
  assert.deepEqual(frameCalls.map((call) => call.args[call.args.indexOf('-ss') + 1]).map(Number), artifact.sheet.cellTimes);
});

test('an unavailable scene scan falls back to equal intervals', async () => {
  const f = fixture({ duration: 20, sceneAware: true, scan: async () => { throw new Error('scan failed'); } });
  const artifact = await f.builder.build({ source: { kind: 'url', url: 'https://example.test/clip.mp4' }, name: 'clip.mp4' });
  assert.equal(artifact.info.planning, 'uniform');
  assert.equal(artifact.info.cuts, 0);
  assert.deepEqual(artifact.sheet.cellTimes, [2, 6, 10, 14, 18]);
  assert.match(artifact.manifest.split('\n').at(-1), /这是采样分镜/);
});

test('a static scan uses four cells, while an unavailable scan uses the duration count', async () => {
  const staticFixture = fixture({ duration: 60, sceneAware: true, scan: async () => [] });
  const staticArtifact = await staticFixture.builder.build({
    source: { kind: 'url', url: 'https://example.test/static.mp4' }, name: 'static.mp4',
  });
  assert.equal(staticArtifact.info.planning, 'uniform');
  assert.equal(staticArtifact.info.cells, 4);
  assert.deepEqual(staticArtifact.sheet.cellTimes, [7.5, 22.5, 37.5, 52.5]);

  const unavailableFixture = fixture({
    duration: 60, sceneAware: true, scan: async () => { throw new Error('scan failed'); },
  });
  const unavailableArtifact = await unavailableFixture.builder.build({
    source: { kind: 'url', url: 'https://example.test/unknown.mp4' }, name: 'unknown.mp4',
  });
  assert.equal(unavailableArtifact.info.planning, 'uniform');
  assert.equal(unavailableArtifact.info.cells, 9);
});

test('too few scene cuts also fall back to equal intervals', async () => {
  const f = fixture({ duration: 12, sceneAware: true, scan: async () => [{ t: 6 }] });
  const artifact = await f.builder.build({ source: { kind: 'url', url: 'https://example.test/clip.mp4' }, name: 'clip.mp4' });
  assert.equal(artifact.info.planning, 'uniform');
});
