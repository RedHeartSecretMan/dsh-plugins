/**
 * Storyboard fallback for image-only models.
 *
 * A model that accepts only images cannot receive a `video_url` part. This
 * module turns a video (durable attachment or bare HTTP(S) URL) into one PNG
 * contact sheet plus a compact Chinese manifest. It deliberately has no
 * provider knowledge and no third-party dependencies: ffprobe reads metadata,
 * ffmpeg samples frames and tiles them, and callers can inject `run` for tests.
 *
 * Scene-aware sampling follows the design of `dsh-video-storyboard` by
 * SAOS-3624 (https://github.com/SAOS-3624/dsh-video-storyboard, Apache-2.0):
 * downscaled HSV scanning, a rate-based cut threshold, and cell placement over
 * content segments. This file is an independent, single-sheet implementation;
 * no upstream code was copied. Scene detection is best-effort and falls back to
 * equal-interval sampling when it is disabled or unavailable.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planSegments, scanCuts, segmentTime } from './scenes.js';

const PREFIX = 'session-video-intake: ';
const TEMP_PREFIX = 'session-video-storyboard-';
const DEFAULT_CELLS = 9;
const DEFAULT_CELL_EDGE = 256;
const DEFAULT_TIMEOUT_MS = 120000;
const STDERR_LIMIT = 500;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;

function failure(message, code, cause) {
  const error = cause === undefined
    ? new Error(`${PREFIX}${message}`)
    : new Error(`${PREFIX}${message}`, { cause });
  return Object.assign(error, { code });
}

function isStoryboardFailure(error) {
  return typeof error?.code === 'string' && error.code.startsWith('VIDEO_STORYBOARD_');
}

function isAbort(error, signal) {
  return Boolean(signal?.aborted)
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || error?.code === 'VIDEO_STORYBOARD_ABORTED';
}

function abortFailure(cause) {
  return failure('request aborted', 'VIDEO_STORYBOARD_ABORTED', cause);
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortFailure(signal.reason);
}

function stderrText(error) {
  const value = error?.stderr;
  if (value == null) return '';
  try {
    return (Buffer.isBuffer(value) ? value.toString('utf8') : String(value)).slice(0, STDERR_LIMIT);
  } catch {
    return '';
  }
}

function messageOf(error) {
  try {
    return String(error?.message ?? error).slice(0, STDERR_LIMIT);
  } catch {
    return 'unknown error';
  }
}

function invalidSource(message, cause) {
  return failure(message, 'VIDEO_STORYBOARD_INVALID_SOURCE', cause);
}

function commandFailure(label, error, signal) {
  if (isAbort(error, signal)) return abortFailure(error?.cause ?? error);
  const missing = error?.code === 'ENOENT';
  const stderr = stderrText(error);
  const detail = stderr || messageOf(error);
  const message = missing
    ? `${label} is not available${detail ? `: ${detail}` : ''}`
    : `${label} failed${detail ? `: ${detail}` : ''}`;
  return failure(message, missing ? 'VIDEO_STORYBOARD_UNAVAILABLE' : 'VIDEO_STORYBOARD_FAILED', error?.cause ?? error);
}

function runnerFailure(command, error, stderr, timeoutMs, timedOut, signal) {
  const captured = stderrText({ stderr }) || messageOf(error);
  const aborted = isAbort(error, signal);
  const code = aborted ? 'ABORT_ERR' : timedOut ? 'ETIMEDOUT' : (error?.code ?? 'EXEC_FAILED');
  const reason = aborted ? 'was aborted' : timedOut ? `timed out after ${timeoutMs}ms` : 'failed';
  const result = failure(`${command} ${reason}${captured ? `: ${captured}` : ''}`, code, error);
  result.stderr = captured;
  return result;
}

/**
 * Default runner backed by `child_process.execFile`.
 *
 * The built-in `signal` handling is supplemented with an explicit kill so an
 * aborted/timed-out child is definitely terminated. stderr is retained (first
 * 500 chars) in both the message and the `stderr` property for summarisation.
 */
export function createDefaultRunner() {
  return function run(command, args, options = {}) {
    const { timeoutMs = 0, signal } = options ?? {};
    return new Promise((resolve, reject) => {
      let child;
      let timer;
      let settled = false;
      let timedOut = false;

      const cleanup = () => {
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        signal?.removeEventListener?.('abort', onAbort);
      };

      const onAbort = () => {
        if (settled) return;
        child?.kill('SIGKILL');
      };

      const settle = (error, stdout, stderr) => {
        if (settled) return;
        const failure = error ? runnerFailure(command, error, stderr, timeoutMs, timedOut, signal) : undefined;
        cleanup();
        if (failure) reject(failure);
        else resolve({ stdout: stdout ?? '' });
      };

      try {
        child = execFile(command, args, {
          encoding: 'utf8',
          maxBuffer: MAX_STDOUT_BYTES,
          signal,
          killSignal: 'SIGKILL',
        }, settle);
      } catch (error) {
        settle(error, '', '');
        return;
      }
      if (settled) return;

      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          child?.kill('SIGKILL');
        }, timeoutMs);
        timer.unref?.();
      }
    });
  };
}

function positiveNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function dimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function formatClock(seconds) {
  const hundredths = Math.round(Math.max(0, Number(seconds) || 0) * 100);
  const minutes = Math.floor(hundredths / 6000);
  const remainder = hundredths % 6000;
  return `${String(minutes).padStart(2, '0')}:${(remainder / 100).toFixed(2).padStart(5, '0')}`;
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

function sourceExtension(value) {
  if (typeof value !== 'string') return '';
  const extension = path.extname(value);
  return /^\.[A-Za-z0-9]{1,8}$/.test(extension) ? extension.toLowerCase() : '';
}

function urlName(parsed) {
  const base = path.posix.basename(parsed.pathname);
  if (!base) return parsed.hostname || 'video';
  try {
    return decodeURIComponent(base) || parsed.hostname || 'video';
  } catch {
    return base || parsed.hostname || 'video';
  }
}

function displayName(preferred, fallback) {
  return cleanName(preferred) || cleanName(fallback) || 'video';
}

function validateRef(ref) {
  if (!ref || typeof ref !== 'object') throw invalidSource('the attachment reference is missing');
  if (!/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId ?? '')) {
    throw invalidSource('the attachment reference does not carry a sha256:... id');
  }
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) {
    throw invalidSource('the attachment reference does not carry a positive byte count');
  }
}

async function readAttachment(ref, attachments, signal) {
  const chunks = [];
  const hash = createHash('sha256');
  let bytes = 0;
  checkAbort(signal);
  try {
    for await (const chunk of attachments.readFileStream(ref, signal)) {
      checkAbort(signal);
      if (!(chunk instanceof Uint8Array)) throw invalidSource('the attachment stream returned non-byte data');
      const copy = Buffer.from(chunk);
      bytes += copy.byteLength;
      hash.update(copy);
      chunks.push(copy);
    }
  } catch (error) {
    if (isStoryboardFailure(error)) throw error;
    if (isAbort(error, signal)) throw abortFailure(error?.cause ?? error);
    throw invalidSource(`could not read the video attachment: ${messageOf(error)}`, error?.cause ?? error);
  }
  checkAbort(signal);
  if (bytes !== ref.bytes || `sha256:${hash.digest('hex')}` !== ref.attachmentId) {
    throw invalidSource(`attachment failed byte count or SHA-256 integrity verification (read ${bytes} bytes)`);
  }
  return Buffer.concat(chunks, bytes);
}

async function prepareSource({ source, name, signal, attachments, tempDir }) {
  if (!source || typeof source !== 'object') throw invalidSource('the video source is missing');

  if (source.kind === 'url') {
    const url = source.url;
    if (typeof url !== 'string' || url !== url.trim() || /\s/.test(url)) {
      throw invalidSource('the video URL must be a bare HTTP(S) URL');
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      throw invalidSource('the video URL is not valid', error);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw invalidSource('the video URL must use http or https');
    }
    return { input: url, name: displayName(name, urlName(parsed)) };
  }

  if (source.kind !== 'attachment') throw invalidSource('the video source kind is unsupported');
  const ref = source.ref;
  validateRef(ref);
  if (typeof attachments?.readFileStream !== 'function') {
    throw invalidSource('durable attachments.readFileStream is required for an attachment source');
  }
  const data = await readAttachment(ref, attachments, signal);
  const input = path.join(tempDir, `source${sourceExtension(ref.name || name)}`);
  await writeFile(input, data);
  return { input, name: displayName(name, ref.name) };
}

async function requireNonEmptyFile(file, message) {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    throw failure(`${message}: ${error?.code ?? messageOf(error)}`, 'VIDEO_STORYBOARD_FAILED', error);
  }
  if (!info.isFile() || info.size <= 0) throw failure(message, 'VIDEO_STORYBOARD_FAILED');
}

/**
 * Create a storyboard builder. `run` is injectable so tests can provide a fake
 * ffmpeg/ffprobe without spawning processes; all other options have defaults.
 */
export function createStoryboardBuilder({
  run = createDefaultRunner(),
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
  cells = DEFAULT_CELLS,
  cellEdge = DEFAULT_CELL_EDGE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sceneAware = false,
  scan = scanCuts,
} = {}) {
  if (typeof run !== 'function') throw failure('run must be a function', 'VIDEO_STORYBOARD_INVALID_CONFIG');
  if (typeof ffmpegPath !== 'string' || !ffmpegPath) {
    throw failure('ffmpegPath must be a non-empty string', 'VIDEO_STORYBOARD_INVALID_CONFIG');
  }
  if (typeof ffprobePath !== 'string' || !ffprobePath) {
    throw failure('ffprobePath must be a non-empty string', 'VIDEO_STORYBOARD_INVALID_CONFIG');
  }
  if (!Number.isSafeInteger(cells) || cells < 4) {
    throw failure('cells must be a safe integer >= 4', 'VIDEO_STORYBOARD_INVALID_CONFIG');
  }
  if (!Number.isSafeInteger(cellEdge) || cellEdge <= 0) {
    throw failure('cellEdge must be a positive safe integer', 'VIDEO_STORYBOARD_INVALID_CONFIG');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw failure('timeoutMs must be a positive safe integer', 'VIDEO_STORYBOARD_INVALID_CONFIG');
  }

  async function runTool(command, args, options) {
    return run(command, args, options);
  }

  async function probeVideo(input, signal) {
    checkAbort(signal);
    let result;
    try {
      result = await runTool(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input], {
        timeoutMs,
        signal,
      });
    } catch (error) {
      throw commandFailure('ffprobe', error, signal);
    }
    checkAbort(signal);

    const stdout = result?.stdout;
    if (typeof stdout !== 'string' && !(stdout instanceof Uint8Array)) {
      throw failure('ffprobe produced no output', 'VIDEO_STORYBOARD_FAILED');
    }
    const text = typeof stdout === 'string' ? stdout : Buffer.from(stdout).toString('utf8');
    if (!text.trim()) throw failure('ffprobe produced no output', 'VIDEO_STORYBOARD_FAILED');

    let metadata;
    try {
      metadata = JSON.parse(text);
    } catch (error) {
      throw failure('ffprobe returned unparsable metadata', 'VIDEO_STORYBOARD_PROBE_FAILED', error);
    }

    const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
    const video = streams.find((stream) => stream?.codec_type === 'video');
    if (!video) throw failure('ffprobe reported no video stream', 'VIDEO_STORYBOARD_PROBE_FAILED');
    const duration = positiveNumber(metadata?.format?.duration) ?? positiveNumber(video.duration);
    if (duration === undefined) throw failure('ffprobe did not report a usable duration', 'VIDEO_STORYBOARD_PROBE_FAILED');

    return {
      duration,
      width: dimension(video.width),
      height: dimension(video.height),
      hasAudio: streams.some((stream) => stream?.codec_type === 'audio'),
    };
  }

  async function extractFrames({ input, count, cellTimes, tempDir, signal }) {
    for (let index = 0; index < count; index++) {
      checkAbort(signal);
      const output = path.join(tempDir, `frame-${String(index).padStart(3, '0')}.jpg`);
      const args = [
        '-ss', cellTimes[index].toFixed(3),
        '-i', input,
        '-frames:v', '1',
        '-vf', `scale='min(${cellEdge},iw)':-2`,
        '-q:v', '4',
        output,
      ];
      try {
        await runTool(ffmpegPath, args, { timeoutMs, signal });
      } catch (error) {
        throw commandFailure('ffmpeg', error, signal);
      }
      checkAbort(signal);
      await requireNonEmptyFile(output, `ffmpeg did not produce frame ${index + 1}`);
    }
  }

  async function composeSheet({ tempDir, cols, rows, signal }) {
    const output = path.join(tempDir, 'storyboard.png');
    const pattern = path.join(tempDir, '*.jpg');
    const args = [
      '-f', 'image2',
      '-pattern_type', 'glob',
      '-i', pattern,
      '-vf', `tile=${cols}x${rows}:padding=4:margin=4`,
      '-frames:v', '1',
      output,
    ];
    try {
      await runTool(ffmpegPath, args, { timeoutMs, signal });
    } catch (error) {
      throw commandFailure('ffmpeg', error, signal);
    }
    checkAbort(signal);
    await requireNonEmptyFile(output, 'ffmpeg did not produce the storyboard image');
    let png;
    try {
      png = await readFile(output);
    } catch (error) {
      throw failure(`could not read the storyboard image: ${messageOf(error)}`, 'VIDEO_STORYBOARD_FAILED', error);
    }
    if (!png.length) throw failure('ffmpeg produced an empty storyboard image', 'VIDEO_STORYBOARD_FAILED');
    return png;
  }

  function buildManifest({ name, duration, segments, count, cols, rows, planning }) {
    const lines = [
      `视频分镜：${name}；时长 ${formatClock(duration)}；${cols}×${rows} 网格（${count} 格）；按从左到右、从上到下阅读。`,
    ];
    for (let index = 0; index < segments.length; index++) {
      lines.push(`第 ${index + 1} 格 = ${formatClock(segments[index][0])}–${formatClock(segments[index][1])}`);
    }
    lines.push(planning === 'scene'
      ? '分镜按场景切点分配，不是连续视频；细节请要求更高分辨率或指定时间段'
      : '这是采样分镜，不是连续视频；细节请要求更高分辨率或指定时间段');
    return lines.join('\n');
  }

  /**
   * Equal-interval plan. `countOverride` is used when the scan succeeded but
   * found too few cuts: a static video should not spend the full duration-based
   * cell budget repeating the same frame.
   */
  function uniformPlan(duration, countOverride, cuts = 0) {
    const count = Math.min(cells, Math.max(1, countOverride ?? Math.max(4, Math.ceil(duration / 4))));
    const segments = Array.from({ length: count }, (_, index) => [
      (duration * index) / count,
      (duration * (index + 1)) / count,
    ]);
    return { segments, count, cuts, planning: 'uniform' };
  }

  /** Scene-aware plan with a safe fallback; cancellation still aborts. */
  async function planFor({ input, duration, signal }) {
    if (!sceneAware) return uniformPlan(duration);
    try {
      const cuts = await scan({ input, ffmpegPath, duration, timeoutMs, signal });
      if (!Array.isArray(cuts)) return uniformPlan(duration);
      if (cuts.length < 2) return uniformPlan(duration, Math.min(4, cells), cuts.length);
      const plan = planSegments(duration, cuts, { cells });
      return plan.count >= Math.min(4, cells) ? { ...plan, planning: 'scene' } : uniformPlan(duration);
    } catch (error) {
      if (isAbort(error, signal)) throw abortFailure(error);
      return uniformPlan(duration);
    }
  }

  async function build({ source, name, signal, attachments } = {}) {
    checkAbort(signal);
    let tempDir;
    try {
      tempDir = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
      const prepared = await prepareSource({ source, name, signal, attachments, tempDir });
      const probe = await probeVideo(prepared.input, signal);

      const plan = await planFor({ input: prepared.input, duration: probe.duration, signal });
      const count = plan.count;
      const cellTimes = plan.segments.map(segmentTime);
      const cols = count <= 4 ? 2 : 3;
      const rows = Math.ceil(count / cols);

      await extractFrames({ input: prepared.input, count, cellTimes, tempDir, signal });
      const png = await composeSheet({ tempDir, cols, rows, signal });
      checkAbort(signal);

      const manifest = buildManifest({
        name: prepared.name,
        duration: probe.duration,
        segments: plan.segments,
        count,
        cols,
        rows,
        planning: plan.planning,
      });
      return {
        png,
        manifest,
        info: {
          duration: probe.duration,
          width: probe.width,
          height: probe.height,
          hasAudio: probe.hasAudio,
          cells: count,
          cols,
          rows,
          planning: plan.planning,
          cuts: plan.cuts,
        },
        sheet: { cellTimes },
      };
    } catch (error) {
      if (isStoryboardFailure(error)) throw error;
      if (isAbort(error, signal)) throw abortFailure(error?.cause ?? error);
      throw failure(`storyboard build failed: ${messageOf(error)}`, 'VIDEO_STORYBOARD_FAILED', error?.cause ?? error);
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { build };
}
