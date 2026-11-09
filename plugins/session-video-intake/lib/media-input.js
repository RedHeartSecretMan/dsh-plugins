/**
 * Shared host-side video input detection.
 *
 * The composer client bundle runs in the browser and cannot import this module;
 * it keeps only the extension check. Everything else in the host plugin uses
 * these helpers so URL rules and container support live in one place.
 * @module session-video-intake/media-input
 */
import { fileURLToPath } from 'node:url';

/** Supported video container extensions, in canonical order. */
export const VIDEO_EXTENSIONS = Object.freeze([
  'mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi', 'ts', 'mts', 'm2ts', 'flv', '3gp', 'ogv',
]);

// Longest first so `.m2ts` wins over `.ts`; the list stays one source of truth.
const VIDEO_EXTENSION = new RegExp(
  `\\.(${[...VIDEO_EXTENSIONS].sort((left, right) => right.length - left.length).join('|')})$`,
  'i',
);
const BARE_VIDEO_URL = /```[\s\S]*?```|`[^`]*`|https?:\/\/[^\s<>"'`，。！？；（）]+/gi;

/** Lower-case supported video extension, or undefined for any other name. */
export function videoExtension(name) {
  return VIDEO_EXTENSION.exec(typeof name === 'string' ? name : '')?.[1].toLowerCase();
}

/** True when a file name carries a supported video extension. */
export function isVideoFileName(name) {
  return videoExtension(name) !== undefined;
}

/** Lower-case subtype of a `video/*` media type, or undefined for any other value. */
export function videoMediaType(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^video\/([a-z0-9][a-z0-9.+_-]*)$/i.exec(value.trim());
  return match?.[1].toLowerCase();
}

/** True when a MIME/media type names a video. */
export function isVideoMediaType(value) {
  return videoMediaType(value) !== undefined;
}

/**
 * Video extension for one attachment: an explicit `video/*` media type wins,
 * the display-name extension remains the fallback for older references.
 * @param {object} [attachment] durable reference or composer attachment.
 * @returns {string|undefined} lower-case extension or media subtype.
 */
export function attachmentVideoExtension(attachment) {
  return videoMediaType(attachment?.mediaType) ?? videoExtension(attachment?.name);
}

/** True when an attachment is a video by media type or by name extension. */
export function isVideoAttachment(attachment) {
  return attachmentVideoExtension(attachment) !== undefined;
}

/**
 * Find bare HTTP(S) video links in user text. Markdown links, quoted strings
 * and fenced code stay ordinary text.
 * @param {string} text user text.
 * @returns {Array<{needle: string, url: string, offset: number}>}
 */
export function findBareVideoUrls(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const result = [];
  for (const match of text.matchAll(BARE_VIDEO_URL)) {
    if (!/^https?:\/\//i.test(match[0])) continue;
    const start = match.index;
    if (start > 0 && !/\s/.test(text[start - 1])) continue;
    const raw = match[0].replace(/[.,;!?)\]}]+$/, '');
    if (raw.length !== match[0].length && /[)\]}]/.test(match[0].slice(raw.length))) continue;
    let url;
    try { url = new URL(raw); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || /^[^:]+:\/\/[^/?#]*@/.test(url.href) || !videoExtension(url.pathname)) continue;
    result.push({ needle: raw, url: raw, offset: start });
  }
  return result;
}

// Explicit local references are ordinary user text, not Markdown or code:
// `@<absolute path>` mentions (including the composer's quoted form for paths
// with whitespace) and `file://` URIs, both only at a token boundary.
const MENTION = /(^|[\s])@(?:"([^"\n]+)"|([^\s<>"'`，。！？；：、()\[\]{}]+))/gu;
const FILE_URL = /(^|[\s])(file:\/\/[^\s<>"'`，。！？；：、()\[\]{}]+)/giu;
const TRAILING_PUNCTUATION = /[.,;!?。，；：！？]+$/;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;
const UNC_PATH = /^\\\\/;

function isAbsoluteLocalPath(value) {
  return value.startsWith('/') || WINDOWS_DRIVE.test(value) || UNC_PATH.test(value);
}

function fileUrlPath(raw) {
  let url;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== 'file:') return undefined;
  try {
    return fileURLToPath(url);
  } catch {
    // A Windows drive or UNC file URL is still an explicit reference on a
    // non-Windows host: keep the decoded path so materialization fails loudly
    // instead of silently ignoring a video-looking reference.
    try { return decodeURIComponent(url.pathname); } catch { return undefined; }
  }
}

/**
 * Find explicit local video references in user text.
 * @param {string} text user text.
 * @returns {Array<{needle: string, offset: number, path: string}>} exact
 *   source text, its offset, and the local path to materialize.
 */
export function findVideoFileReferences(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const result = [];
  for (const match of text.matchAll(MENTION)) {
    const quoted = match[2];
    const raw = quoted ?? match[3];
    if (raw === undefined) continue;
    const value = quoted !== undefined ? raw : raw.replace(TRAILING_PUNCTUATION, '');
    if (!isAbsoluteLocalPath(value) || videoExtension(value) === undefined) continue;
    result.push({
      needle: quoted !== undefined ? `@"${value}"` : `@${value}`,
      offset: match.index + match[1].length,
      path: value,
    });
  }
  for (const match of text.matchAll(FILE_URL)) {
    const raw = match[2].replace(TRAILING_PUNCTUATION, '');
    const path = fileUrlPath(raw);
    if (path === undefined || videoExtension(path) === undefined) continue;
    result.push({ needle: raw, offset: match.index + match[1].length, path });
  }
  return result.sort((left, right) => left.offset - right.offset);
}
