/**
 * Scene-aware sampling for the storyboard fallback.
 *
 * Design inspiration: `dsh-video-storyboard` by SAOS-3624
 * (https://github.com/SAOS-3624/dsh-video-storyboard), Apache-2.0. Its author
 * scans a downscaled video with HSV per-channel differences, derives a
 * rate-based cut threshold, then distributes cells over the resulting segments.
 * This module is an independent, much smaller implementation for one contact
 * sheet; no upstream code was copied.
 *
 * The scan decodes 64x36 RGB frames at a fixed low rate, so its cost stays far
 * below a full-resolution decode. Cutting detection is a signal, not a promise:
 * when the scan is unavailable the caller falls back to uniform sampling.
 * @module session-video-intake/scenes
 */
import { spawn } from 'node:child_process';

export const SCAN_WIDTH = 64;
export const SCAN_HEIGHT = 36;
export const SCAN_FPS = 4;
export const MIN_CUT_SCORE = 12;
export const MIN_GAP_SECONDS = 0.35;
export const MIN_SEGMENT_SECONDS = 0.4;
export const MAX_SCAN_BYTES = 48 * 1024 * 1024;
const SCAN_FRAME_BYTES = SCAN_WIDTH * SCAN_HEIGHT * 3;

function frameHsv(raw, offset, out) {
  for (let pixel = 0, i = offset; i < offset + SCAN_FRAME_BYTES; i += 3, pixel += 1) {
    const r = raw[i] / 255;
    const g = raw[i + 1] / 255;
    const b = raw[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;
    if (delta !== 0) {
      if (max === r) hue = ((g - b) / delta) % 6;
      else if (max === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
    }
    const at = pixel * 3;
    out[at] = (hue / 360) * 255;
    out[at + 1] = max === 0 ? 0 : (delta / max) * 255;
    out[at + 2] = max * 255;
  }
}

/**
 * Per-frame HSV difference scores between consecutive decoded frames.
 * @param {Buffer|Uint8Array} raw concatenated rgb24 frames.
 * @returns {number[]} one score (0-255) for every frame after the first.
 */
export function frameScores(raw) {
  if (!(raw instanceof Uint8Array)) throw new TypeError('scene scan needs a byte buffer');
  const frames = Math.floor(raw.length / SCAN_FRAME_BYTES);
  const previous = new Float32Array(SCAN_FRAME_BYTES);
  const current = new Float32Array(SCAN_FRAME_BYTES);
  const scores = [];
  if (frames < 2) return scores;
  frameHsv(raw, 0, previous);
  for (let frame = 1; frame < frames; frame += 1) {
    frameHsv(raw, frame * SCAN_FRAME_BYTES, current);
    let sum = 0;
    for (let i = 0; i < SCAN_FRAME_BYTES; i += 3) {
      sum += Math.abs(current[i] - previous[i])
        + Math.abs(current[i + 1] - previous[i + 1])
        + Math.abs(current[i + 2] - previous[i + 2]);
    }
    // Mean per channel on the 0-255 scale; three channels share the denominator.
    scores.push(sum / SCAN_FRAME_BYTES);
    previous.set(current);
  }
  return scores;
}

/**
 * Rate-based threshold: target roughly one cut per 1.5 seconds, never below
 * `floor`, so static footage (where every score is tiny) reports no cuts.
 */
export function autoThreshold(scores, { duration, floor = MIN_CUT_SCORE } = {}) {
  if (!Array.isArray(scores) || scores.length === 0) return floor;
  const sorted = [...scores].sort((a, b) => a - b);
  const target = Math.max(1, Math.round((Number(duration) || 0) / 1.5));
  const index = Math.max(0, Math.min(sorted.length - 1, sorted.length - target));
  const value = sorted[index];
  // Ties land exactly on the boundary scores; step below the whole tie group.
  let first = index;
  while (first > 0 && sorted[first - 1] === value) first -= 1;
  return Math.max(floor, first > 0 ? sorted[first - 1] : value);
}

function suppressClose(events, gap) {
  const kept = [];
  for (const event of events) {
    if (kept.length === 0 || event.t - kept[kept.length - 1].t >= gap) kept.push(event);
  }
  return kept;
}

/**
 * Detect cut times from per-frame scores.
 * @param {number[]} scores see {@link frameScores}.
 * @param {object} options `fps` of the sampled scan, `duration`, `minGap`, `floor`.
 * @returns {Array<{t:number, score:number}>} cut candidates in time order.
 */
export function cutsFromScores(scores, { fps = SCAN_FPS, duration, minGap = MIN_GAP_SECONDS, floor = MIN_CUT_SCORE } = {}) {
  if (!(fps > 0)) throw new RangeError('scene scan fps must be positive');
  if (!Array.isArray(scores) || scores.length === 0) return [];
  const step = 1 / fps;
  const threshold = autoThreshold(scores, { duration, floor });
  const above = [];
  for (let index = 0; index < scores.length; index += 1) {
    if (scores[index] > threshold) above.push({ t: (index + 1) * step, score: scores[index] });
  }
  const events = [];
  for (const candidate of above) {
    const last = events[events.length - 1];
    if (last === undefined || candidate.t - last.t > step * 1.5) events.push({ ...candidate });
    else if (candidate.score > last.score) events[events.length - 1] = { ...candidate };
  }
  if (events.length < 6) return suppressClose(events, minGap);
  const gaps = events.slice(1).map((event, index) => event.t - events[index].t).sort((a, b) => a - b);
  const typical = gaps[Math.floor(gaps.length * 0.25)];
  const effective = typical > 0 && typical < minGap ? Math.max(step * 1.2, typical * 0.8) : minGap;
  return suppressClose(events, effective);
}

/** Ordered, edge-to-edge segments derived from cut times. */
export function segmentsFromCuts(duration, cuts, minLength = MIN_SEGMENT_SECONDS) {
  if (!(duration > 0)) throw new RangeError('duration must be positive');
  const inner = (Array.isArray(cuts) ? cuts : [])
    .map((cut) => (typeof cut === 'number' ? cut : cut?.t))
    .filter((t) => Number.isFinite(t) && t > minLength && t < duration - minLength)
    .sort((a, b) => a - b);
  const bounds = [0, ...inner, duration];
  const segments = [];
  for (let index = 0; index < bounds.length - 1; index += 1) {
    if (bounds[index + 1] - bounds[index] >= minLength) segments.push([bounds[index], bounds[index + 1]]);
  }
  if (segments.length === 0) return [[0, duration]];
  const merged = [segments[0].slice()];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = merged[merged.length - 1];
    if (Math.abs(segments[index][0] - previous[1]) < 1e-6) merged.push(segments[index].slice());
    else previous[1] = segments[index][1];
  }
  return merged;
}

const segmentLength = (segment) => segment[1] - segment[0];

function mergeShorterThan(segments, minimum) {
  if (!(minimum > 0)) return segments;
  const out = segments.map((segment) => segment.slice());
  let guard = 0;
  while (out.length > 1 && guard < 10000) {
    guard += 1;
    const index = out.findIndex((segment) => segmentLength(segment) < minimum);
    if (index < 0) break;
    const left = index > 0 ? segmentLength(out[index - 1]) : Infinity;
    const right = index < out.length - 1 ? segmentLength(out[index + 1]) : Infinity;
    if (left <= right && index > 0) out.splice(index - 1, 2, [out[index - 1][0], out[index][1]]);
    else if (right < left && index < out.length - 1) out.splice(index, 2, [out[index][0], out[index + 1][1]]);
    else break;
  }
  return out;
}

/**
 * Adjust segments to exactly `count`: merge the shortest neighbouring pair when
 * there are too many, split the longest segment when there are too few.
 */
export function fitSegments(segments, count, { minGap = 0 } = {}) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('segment count must be a positive integer');
  let out = segments.map((segment) => [Number(segment[0]), Number(segment[1])]);
  const durations = out.map(segmentLength).sort((a, b) => a - b);
  const median = durations.length === 0 ? 0 : durations[Math.floor(durations.length / 2)];
  const gap = minGap > 0 ? Math.min(minGap, Math.max(0.2, median * 0.9)) : 0;
  out = mergeShorterThan(out, gap);
  while (out.length > count) {
    let index = 0;
    let smallest = Infinity;
    for (let i = 0; i < out.length - 1; i += 1) {
      const sum = segmentLength(out[i]) + segmentLength(out[i + 1]);
      if (sum < smallest) {
        smallest = sum;
        index = i;
      }
    }
    out.splice(index, 2, [out[index][0], out[index + 1][1]]);
  }
  let guard = 0;
  while (out.length < count && guard < 1000) {
    guard += 1;
    let index = 0;
    for (let i = 1; i < out.length; i += 1) {
      if (segmentLength(out[i]) > segmentLength(out[index])) index = i;
    }
    const [from, to] = out[index];
    const floor = Math.max(0.2, gap);
    if (to - from < floor * 2) break;
    const middle = (from + to) / 2;
    out.splice(index, 1, [from, middle], [middle, to]);
  }
  return out;
}

/**
 * Derive cell count and segment boundaries for one video.
 * @param {number} duration seconds.
 * @param {Array} cuts cut candidates.
 * @param {object} options `cells` cap and `maxCells` fallback budget.
 */
export function planSegments(duration, cuts, { cells = 9 } = {}) {
  const cutCount = Array.isArray(cuts) ? cuts.length : 0;
  const longest = Math.max(4, Math.floor(duration / 0.8));
  const target = Math.max(4, Math.min(cells, Math.round(1 + cutCount * 1.2), longest));
  const segments = fitSegments(segmentsFromCuts(duration, cuts), target, { minGap: 0.6 });
  return { segments, count: segments.length, cuts: cutCount };
}

/** Sampling point at the centre of one segment. */
export function segmentTime(segment) {
  return Number((((segment[0] + segment[1]) / 2).toFixed(3)));
}

/**
 * Decode low-resolution RGB frames for scene scanning.
 * @param {object} options input path or URL, ffmpeg path, timeout and abort signal.
 * @returns {Promise<{raw: Buffer, bytesPerFrame: number}>}
 */
export function decodeScanFrames({ input, ffmpegPath = 'ffmpeg', timeoutMs = 120000, signal, maxBytes = MAX_SCAN_BYTES }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('session-video-intake: scene scan aborted'), { code: 'VIDEO_STORYBOARD_ABORTED' }));
      return;
    }
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', input,
      '-vf', `fps=${SCAN_FPS},scale=${SCAN_WIDTH}:${SCAN_HEIGHT}:flags=area,format=rgb24`,
      '-f', 'rawvideo', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else resolve(value);
    };
    const onAbort = () => finish(Object.assign(new Error('session-video-intake: scene scan aborted'), { code: 'VIDEO_STORYBOARD_ABORTED' }));
    const timer = setTimeout(() => finish(Object.assign(new Error('session-video-intake: scene scan timed out'), { code: 'VIDEO_STORYBOARD_FAILED' })), timeoutMs);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.on('error', (error) => finish(Object.assign(error, { code: error?.code ?? 'VIDEO_STORYBOARD_FAILED' })));
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        finish(Object.assign(new Error('session-video-intake: scene scan exceeded its byte budget'), { code: 'VIDEO_STORYBOARD_FAILED' }));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 500) stderr += chunk.toString('utf8').slice(0, 500 - stderr.length);
    });
    child.on('close', (code) => {
      if (code === 0) finish(undefined, { raw: Buffer.concat(chunks), bytesPerFrame: SCAN_FRAME_BYTES });
      else finish(Object.assign(new Error(`session-video-intake: scene scan failed: ${stderr.trim() || `exit ${code}`}`), { code: 'VIDEO_STORYBOARD_FAILED' }));
    });
  });
}

/** Probe cut times for one input; throws only on abort or tool failure. */
export async function scanCuts({ input, ffmpegPath, duration, timeoutMs, signal, decode = decodeScanFrames }) {
  const { raw } = await decode({ input, ffmpegPath, timeoutMs, signal });
  const frames = Math.floor(raw.length / SCAN_FRAME_BYTES);
  if (frames < 3) return [];
  const fps = Math.min(SCAN_FPS, frames / Math.max(duration, 1e-6));
  const scores = frameScores(raw);
  return cutsFromScores(scores, { fps, duration });
}
