/**
 * Conditional managed FFmpeg fallback.
 *
 * The plugin first probes local binaries. Only when none can compose a
 * storyboard does it download the LGPL platform packages below into
 * `$DSH_HOME/tools/ffmpeg/managed/<id>/`. Nothing is downloaded when a local
 * build already meets the requirements.
 * @module session-video-intake/managed-ffmpeg
 */
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { failure } from './failure.js';

const MANAGED_ID = 'npm-lgpl-4.1';
const DOWNLOAD_TIMEOUT_MS = 600_000;

/** Pinned LGPL FFmpeg 4.1 / ffprobe 5.x platform packages. */
export const MANAGED_PACKAGES = Object.freeze({
  'darwin-arm64': {
    ffmpeg: { url: 'https://registry.npmjs.org/@ffmpeg-installer/darwin-arm64/-/darwin-arm64-4.1.5.tgz', integrity: 'sha512-hYqTiP63mXz7wSQfuqfFwfLOfwwFChUedeCVKkBtl/cliaTM7/ePI9bVzfZ2c+dWu3TqCwLDRWNSJ5pqZl8otA==' },
    ffprobe: { url: 'https://registry.npmjs.org/@ffprobe-installer/darwin-arm64/-/darwin-arm64-5.0.1.tgz', integrity: 'sha512-vwNCNjokH8hfkbl6m95zICHwkSzhEvDC3GVBcUp5HX8+4wsX10SP3B+bGur7XUzTIZ4cQpgJmEIAx6TUwRepMg==' },
  },
  'darwin-x64': {
    ffmpeg: { url: 'https://registry.npmjs.org/@ffmpeg-installer/darwin-x64/-/darwin-x64-4.1.0.tgz', integrity: 'sha512-Z4EyG3cIFjdhlY8wI9aLUXuH8nVt7E9SlMVZtWvSPnm2sm37/yC2CwjUzyCQbJbySnef1tQwGG2Sx+uWhd9IAw==' },
    ffprobe: { url: 'https://registry.npmjs.org/@ffprobe-installer/darwin-x64/-/darwin-x64-5.1.0.tgz', integrity: 'sha512-J+YGscZMpQclFg31O4cfVRGmDpkVsQ2fZujoUdMAAYcP0NtqpC49Hs3SWJpBdsGB4VeqOt5TTm1vSZQzs1NkhA==' },
  },
  'linux-x64': {
    ffmpeg: { url: 'https://registry.npmjs.org/@ffmpeg-installer/linux-x64/-/linux-x64-4.1.0.tgz', integrity: 'sha512-Y5BWhGLU/WpQjOArNIgXD3z5mxxdV8c41C+U15nsE5yF8tVcdCGet5zPs5Zy3Ta6bU7haGpIzryutqCGQA/W8A==' },
    ffprobe: { url: 'https://registry.npmjs.org/@ffprobe-installer/linux-x64/-/linux-x64-5.2.0.tgz', integrity: 'sha512-D3UeqTLYPNs7pBWPLUYGehPdRVqU8eACox4OZy3pZUZatxye2YKlvBwEfaLdL1v2Z4FOAlLUhms0kY8m8kqSRA==' },
  },
  'linux-arm64': {
    ffmpeg: { url: 'https://registry.npmjs.org/@ffmpeg-installer/linux-arm64/-/linux-arm64-4.1.4.tgz', integrity: 'sha512-dljEqAOD0oIM6O6DxBW9US/FkvqvQwgJ2lGHOwHDDwu/pX8+V0YsDL1xqHbj1DMX/+nP9rxw7G7gcUvGspSoKg==' },
    ffprobe: { url: 'https://registry.npmjs.org/@ffprobe-installer/linux-arm64/-/linux-arm64-5.2.0.tgz', integrity: 'sha512-X1VvWtlLs6ScP73biVLuHD5ohKJKsMTa0vafCESOen4mOoNeLAYbxOVxDWAdFz9cpZgRiloFj5QD6nDj8E28yQ==' },
  },
  'win32-x64': {
    ffmpeg: { url: 'https://registry.npmjs.org/@ffmpeg-installer/win32-x64/-/win32-x64-4.1.0.tgz', integrity: 'sha512-Drt5u2vzDnIONf4ZEkKtFlbvwj6rI3kxw1Ck9fpudmtgaZIHD4ucsWB2lCZBXRxJgXR+2IMSti+4rtM4C4rXgg==' },
    ffprobe: { url: 'https://registry.npmjs.org/@ffprobe-installer/win32-x64/-/win32-x64-5.1.0.tgz', integrity: 'sha512-jMGYeAgkrdn4e2vvYt/qakgHRE3CPju4bn5TmdPfoAm1BlX1mY9cyMd8gf5vSzI8gH8Zq5WQAyAkmekX/8TSTg==' },
  },
});

/** Platform key used by the pinned manifest. */
export function managedPlatformKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  return Object.hasOwn(MANAGED_PACKAGES, key) ? key : undefined;
}

function verifyIntegrity(buffer, integrity) {
  const [algorithm, expected] = integrity.split('-', 2);
  if (algorithm !== 'sha512' || !expected) throw new Error('unsupported package integrity');
  const actual = createHash('sha512').update(buffer).digest('base64');
  if (actual !== expected) throw new Error('managed FFmpeg package integrity mismatch');
}

/** Minimal ustar reader: enough for npm package tarballs. */
export function extractTarFile(tar, predicate) {
  let offset = 0;
  let pendingLongName;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    let name = header.toString('utf8', 0, 100).replace(/\0.*$/u, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/u, '');
    if (prefix) name = `${prefix}/${name}`;
    const sizeText = header.toString('ascii', 124, 136).replace(/\0.*$/u, '').trim();
    const size = parseInt(sizeText || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid tar entry size');
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('truncated tar entry');
    if (type === 'x' || type === 'g') {
      pendingLongName = tar.toString('utf8', dataStart, dataEnd).replace(/\0.*$/u, '').trim() || pendingLongName;
    } else if (type === '0' || type === '\0' || type === '7') {
      const entryName = pendingLongName || name;
      if (predicate(entryName)) return tar.subarray(dataStart, dataEnd);
      pendingLongName = undefined;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

function binaryMember(name, executable) {
  const base = path.posix.basename(name).toLowerCase();
  return base === executable || base === `${executable}.exe`;
}

async function downloadPackage(entry, fetchImpl, signal) {
  const response = await fetchImpl(entry.url, { signal });
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  verifyIntegrity(buffer, entry.integrity);
  const tar = gunzipSync(buffer);
  const binary = extractTarFile(tar, (name) => binaryMember(name, entry.name));
  if (!binary?.length) throw new Error(`package did not contain ${entry.name}`);
  return binary;
}

async function exists(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

/**
 * Download the pinned LGPL FFmpeg/ffprobe pair when no local build qualified.
 * `fetchImpl` and `platform` are injectable for tests.
 */
export async function ensureManagedFfmpeg({
  env = process.env, platform = process.platform, arch = process.arch,
  fetchImpl = globalThis.fetch, root,
} = {}) {
  const key = managedPlatformKey(platform, arch);
  if (!key) throw failure(`no managed FFmpeg package for ${platform}-${arch}`, 'VIDEO_FFMPEG_UNSUPPORTED');
  const base = root || path.join(env.DSH_HOME || path.join(homedir(), '.dsh'), 'tools', 'ffmpeg', 'managed', MANAGED_ID, key);
  const ffmpegPath = path.join(base, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const ffprobePath = path.join(base, platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (await exists(ffmpegPath) && await exists(ffprobePath)) return { ffmpegPath, ffprobePath };

  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const temp = `${base}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(temp, { recursive: true });
  try {
    const pair = MANAGED_PACKAGES[key];
    const [ffmpeg, ffprobe] = await Promise.all([
      downloadPackage({ ...pair.ffmpeg, name: 'ffmpeg' }, fetchImpl, signal),
      downloadPackage({ ...pair.ffprobe, name: 'ffprobe' }, fetchImpl, signal),
    ]);
    await writeFile(path.join(temp, path.basename(ffmpegPath)), ffmpeg);
    await writeFile(path.join(temp, path.basename(ffprobePath)), ffprobe);
    if (platform !== 'win32') {
      await chmod(path.join(temp, path.basename(ffmpegPath)), 0o755);
      await chmod(path.join(temp, path.basename(ffprobePath)), 0o755);
    }
    await rm(base, { recursive: true, force: true });
    await mkdir(path.dirname(base), { recursive: true });
    await rename(temp, base);
    return { ffmpegPath, ffprobePath };
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    throw failure(`managed FFmpeg download failed: ${error?.message ?? error}`, 'VIDEO_FFMPEG_UNSUPPORTED', error);
  }
}

/** Read the pinned license/source notice for diagnostics and packaging. */
export async function managedNotice() {
  return readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8').catch(() => '');
}
