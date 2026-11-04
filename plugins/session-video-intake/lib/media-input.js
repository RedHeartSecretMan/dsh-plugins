/**
 * Shared host-side video input detection.
 *
 * The composer client bundle runs in the browser and cannot import this module;
 * it keeps only the extension check. Everything else in the host plugin uses
 * these helpers so URL rules and container support live in one place.
 * @module session-video-intake/media-input
 */

const VIDEO_EXTENSION = /\.(mp4|webm)$/i;
const BARE_VIDEO_URL = /```[\s\S]*?```|`[^`]*`|https?:\/\/[^\s<>"'`，。！？；（）]+/gi;

/** Lower-case MP4/WebM extension, or undefined for any other name. */
export function videoExtension(name) {
  return VIDEO_EXTENSION.exec(typeof name === 'string' ? name : '')?.[1].toLowerCase();
}

/** True when a file name carries a supported video extension. */
export function isVideoFileName(name) {
  return videoExtension(name) !== undefined;
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
