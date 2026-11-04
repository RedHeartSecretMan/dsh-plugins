import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  autoThreshold, cutsFromScores, decodeScanFrames, fitSegments, frameScores,
  planSegments, scanCuts, segmentTime, segmentsFromCuts,
  SCAN_HEIGHT, SCAN_WIDTH,
} from '../lib/scenes.js';

const FRAME_BYTES = SCAN_WIDTH * SCAN_HEIGHT * 3;

function frame([r, g, b]) {
  const buffer = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < buffer.length; i += 3) {
    buffer[i] = r;
    buffer[i + 1] = g;
    buffer[i + 2] = b;
  }
  return buffer;
}

function rawFrames(colors) {
  return Buffer.concat(colors.map(frame));
}

test('frameScores is zero for identical frames and high across a hard cut', () => {
  const scores = frameScores(rawFrames([[10, 10, 10], [10, 10, 10], [250, 250, 250]]));
  assert.equal(scores.length, 2);
  assert.equal(scores[0], 0);
  assert.ok(scores[1] > 70, `expected a large difference, got ${scores[1]}`);
  assert.deepEqual(frameScores(Buffer.alloc(FRAME_BYTES)), [], 'a single frame gives no score');
});

test('autoThreshold uses the floor for static footage and a rate-based value otherwise', () => {
  const staticScores = Array.from({ length: 100 }, () => 1.5);
  assert.equal(autoThreshold(staticScores, { duration: 60 }), 12, 'static footage keeps the floor');
  const dynamicScores = Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? 90 : 3));
  const threshold = autoThreshold(dynamicScores, { duration: 25 });
  assert.ok(threshold > 3 && threshold <= 90, `unexpected threshold ${threshold}`);
});

test('cutsFromScores clusters one hard cut and suppresses close candidates', () => {
  const fps = 4;
  const scores = Array.from({ length: 40 }, () => 2);
  scores[7] = 90;
  scores[8] = 85;
  const cuts = cutsFromScores(scores, { fps, duration: 10 });
  assert.equal(cuts.length, 1, 'adjacent spike frames are one cut');
  assert.ok(Math.abs(cuts[0].t - 2.25) <= 0.3, `unexpected cut time ${cuts[0].t}`);
  assert.deepEqual(cutsFromScores([], { fps }), []);
});

test('segmentsFromCuts drops edge cuts and keeps the timeline contiguous', () => {
  const segments = segmentsFromCuts(10, [0.1, 2, 5, 9.95]);
  assert.deepEqual(segments, [[0, 2], [2, 5], [5, 10]]);
  assert.deepEqual(segmentsFromCuts(5, []), [[0, 5]]);
});

test('fitSegments merges or splits to reach the target count', () => {
  const segments = [[0, 2], [2, 5], [5, 10]];
  assert.deepEqual(fitSegments(segments, 2), [[0, 5], [5, 10]], 'merges the shortest pair');
  assert.deepEqual(fitSegments(segments, 4), [[0, 2], [2, 5], [5, 7.5], [7.5, 10]], 'splits the longest segment');
  assert.equal(fitSegments(segments, 3).length, 3);
});

test('planSegments clamps the cell count and covers the whole video', () => {
  const plan = planSegments(20, [{ t: 4 }, { t: 9 }, { t: 15 }], { cells: 9 });
  assert.ok(plan.count >= 4 && plan.count <= 9);
  assert.equal(plan.segments.length, plan.count);
  assert.equal(plan.segments[0][0], 0);
  assert.equal(plan.segments.at(-1)[1], 20);
  for (let index = 1; index < plan.segments.length; index += 1) {
    assert.equal(plan.segments[index][0], plan.segments[index - 1][1], 'segments are edge-to-edge');
  }
  assert.deepEqual(planSegments(4, [], { cells: 9 }).segments.length, 4);
  assert.equal(planSegments(600, [], { cells: 9 }).count, 4, 'a static video does not spend its full cell budget');
});

test('segmentTime samples the centre of a segment', () => {
  assert.equal(segmentTime([2, 5]), 3.5);
});

test('scanCuts derives cuts from decoded frames and respects the abort state', async () => {
  const raw = rawFrames([
    [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
    [255, 255, 255], [255, 255, 255], [255, 255, 255], [255, 255, 255],
  ]);
  const cuts = await scanCuts({
    input: 'clip.mp4', duration: 5, decode: async () => ({ raw }),
  });
  assert.ok(Array.isArray(cuts));
  assert.ok(cuts.every((cut) => cut.t > 0 && cut.t < 5));

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    decodeScanFrames({ input: 'clip.mp4', signal: controller.signal }),
    { code: 'VIDEO_STORYBOARD_ABORTED' },
  );
  await assert.rejects(
    scanCuts({ input: 'clip.mp4', duration: 5, signal: controller.signal, decode: decodeScanFrames }),
    { code: 'VIDEO_STORYBOARD_ABORTED' },
  );
});
