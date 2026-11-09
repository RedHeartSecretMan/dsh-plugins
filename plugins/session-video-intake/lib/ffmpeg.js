/**
 * FFmpeg capability discovery for the storyboard fallback.
 *
 * The plugin does not assume one FFmpeg build: it probes the binaries actually
 * present, rejects candidates that cannot compose a storyboard, and reports the
 * chosen capabilities so the storyboard can use glob or image2 as appropriate.
 * @module session-video-intake/ffmpeg
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { failure } from './failure.js';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 10_000;
const probeCache = new Map();

function executableName(base, platform) {
  return platform === 'win32' ? `${base}.exe` : base;
}

function siblingProbePath(ffmpegPath, platform) {
  const file = path.basename(ffmpegPath);
  const candidate = file.replace(/^ffmpeg/i, 'ffprobe');
  if (candidate === file) return executableName('ffprobe', platform);
  return path.join(path.dirname(ffmpegPath), candidate);
}

/** Candidate FFmpeg/ffprobe pairs in the order the plugin should try them. */
export function ffmpegCandidates({ storyboard = {}, env = process.env, platform = process.platform } = {}) {
  const ffmpegName = executableName('ffmpeg', platform);
  const ffprobeName = executableName('ffprobe', platform);
  const pairs = [];
  const add = (ffmpegPath, ffprobePath) => {
    if (!ffmpegPath) return;
    if (pairs.some((pair) => pair.ffmpegPath === ffmpegPath)) return;
    pairs.push({ ffmpegPath, ffprobePath: ffprobePath || siblingProbePath(ffmpegPath, platform) });
  };

  // An explicit pair is authoritative: if it is broken, report it instead of
  // silently switching to another binary the user did not choose.
  if (storyboard.ffmpegPath) {
    add(storyboard.ffmpegPath, storyboard.ffprobePath);
    return { pairs, explicit: true };
  }
  if (storyboard.ffprobePath) add(env.SESSION_VIDEO_FFMPEG || ffmpegName, storyboard.ffprobePath);
  if (env.SESSION_VIDEO_FFMPEG) add(env.SESSION_VIDEO_FFMPEG, env.SESSION_VIDEO_FFPROBE);

  const directories = [
    env.DSH_HOME && path.join(env.DSH_HOME, 'tools', 'ffmpeg', 'bin'),
    env.DSH_PROFILE_DIR && path.join(env.DSH_PROFILE_DIR, 'tools', 'ffmpeg', 'bin'),
    path.join(homedir(), '.dsh', 'tools', 'ffmpeg', 'bin'),
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []),
  ].filter(Boolean);
  for (const directory of directories) add(path.join(directory, ffmpegName));

  // Bare names let the runner report a familiar PATH-missing error.
  add(ffmpegName, ffprobeName);
  return { pairs, explicit: false };
}

function outputText(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return '';
}

function hasFilter(list, name) {
  return new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, 'm').test(list);
}

function hasFormat(list, name) {
  return new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, 'm').test(list);
}

function hasEncoder(list, name) {
  return new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, 'm').test(list);
}

/** Parse `ffmpeg -version`, filters, formats and encoders into a capability record. */
export function parseCapabilities({ version, filters, formats, encoders }) {
  const versionText = outputText(version?.stdout ?? version);
  const match = /ffmpeg version\s+(\S+)/i.exec(versionText);
  const filterText = outputText(filters?.stdout ?? filters);
  const formatText = outputText(formats?.stdout ?? formats);
  const encoderText = outputText(encoders?.stdout ?? encoders);
  return {
    version: match?.[1] ?? 'unknown',
    filters: {
      tile: hasFilter(filterText, 'tile'),
      scale: hasFilter(filterText, 'scale'),
      pad: hasFilter(filterText, 'pad'),
    },
    demuxers: {
      image2: hasFormat(formatText, 'image2'),
      concat: hasFormat(formatText, 'concat'),
    },
    encoders: {
      mjpeg: hasEncoder(encoderText, 'mjpeg') || hasEncoder(encoderText, 'jpg'),
    },
  };
}

function cacheKey(pair, platform) {
  try {
    return `${platform}\0${pair.ffmpegPath}\0${statSync(pair.ffmpegPath).mtimeMs}`;
  } catch {
    return `${platform}\0${pair.ffmpegPath}`;
  }
}

/**
 * Probe one FFmpeg pair. Injectable `run` keeps unit tests process-free.
 * @returns {Promise<object>} capability record or a structured rejection.
 */
export async function probeFfmpeg(pair, { run = execFileAsync, platform = process.platform, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const options = { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
  const key = cacheKey(pair, platform);
  if (probeCache.has(key)) return probeCache.get(key);
  try {
    const [version, filters, formats, encoders] = await Promise.all([
      run(pair.ffmpegPath, ['-hide_banner', '-version'], options),
      run(pair.ffmpegPath, ['-hide_banner', '-filters'], options),
      run(pair.ffmpegPath, ['-hide_banner', '-formats'], options),
      run(pair.ffmpegPath, ['-hide_banner', '-encoders'], options),
    ]);
    const versionInfo = await run(pair.ffprobePath, ['-v', 'error', '-version'], options);
    if (!/ffprobe version/i.test(outputText(versionInfo?.stdout ?? versionInfo))) {
      throw new Error('ffprobe did not report a version');
    }
    const capabilities = parseCapabilities({ version, filters, formats, encoders });
    const capable = capabilities.filters.tile && capabilities.filters.scale
      && capabilities.demuxers.image2 && capabilities.encoders.mjpeg;
    const result = { ...capabilities, ffmpegPath: pair.ffmpegPath, ffprobePath: pair.ffprobePath, capable };
    probeCache.set(key, result);
    return result;
  } catch (error) {
    const result = {
      ffmpegPath: pair.ffmpegPath,
      ffprobePath: pair.ffprobePath,
      capable: false,
      error: error?.message ?? String(error),
    };
    probeCache.set(key, result);
    return result;
  }
}

/** Describe one rejected candidate without leaking a full FFmpeg banner. */
function rejectedSummary(candidate) {
  return `${candidate.ffmpegPath}: ${candidate.error ?? 'missing required capability (tile/scale/image2/mjpeg)'}`;
}

/**
 * Choose the first capable FFmpeg pair. An explicit pair is never silently
 * replaced; it either works or produces an actionable failure.
 */
export async function resolveFfmpeg({
  storyboard = {}, env = process.env, platform = process.platform, run = execFileAsync, managed,
} = {}) {
  const { pairs, explicit } = ffmpegCandidates({ storyboard, env, platform });
  const rejected = [];
  for (const pair of pairs) {
    if (pair.ffmpegPath !== 'ffmpeg' && !existsSync(pair.ffmpegPath)) {
      rejected.push(`${pair.ffmpegPath}: not found`);
      continue;
    }
    const candidate = await probeFfmpeg(pair, { run, platform });
    if (candidate.capable) return candidate;
    rejected.push(rejectedSummary(candidate));
  }
  if (!explicit && typeof managed === 'function') {
    try {
      const installed = await managed({ rejected });
      if (installed) {
        const candidate = await probeFfmpeg(installed, { run, platform });
        if (candidate.capable) return candidate;
        rejected.push(rejectedSummary(candidate));
      }
    } catch (error) {
      rejected.push(`managed: ${error?.message ?? error}`);
    }
  }
  throw failure(
    `no FFmpeg build can compose a storyboard; tried: ${rejected.join('; ')}`,
    'VIDEO_FFMPEG_UNSUPPORTED',
  );
}
