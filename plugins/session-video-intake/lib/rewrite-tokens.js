/** Shared token replacement for native video and storyboard projections. */
import { failure } from './failure.js';

/** Concatenate text parts and strip lone surrogates for stable comparisons. */
export function sdkText(content) {
  const text = typeof content === 'string' ? content
    : (content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

export function partText(part) {
  return typeof part?.text === 'string' ? part.text : undefined;
}

function locateEntries(joined, entries) {
  return entries.map((entry) => {
    let start = -entry.needle.length;
    for (let i = 0; i <= entry.occurrence; i++) {
      start = joined.indexOf(entry.needle, start + entry.needle.length);
      if (start < 0) throw failure('the provider projection no longer contains the captured file handle or URL', 'VIDEO_SDK_UNSUPPORTED');
    }
    return { ...entry, start, end: start + entry.needle.length };
  });
}

/**
 * Validate that every captured token is still present in one user message
 * before an expensive attachment read or storyboard build starts.
 */
export function assertVideoTokens(content, entries) {
  const source = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  if (!Array.isArray(source)) throw failure('provider user content is unsupported', 'VIDEO_SDK_UNSUPPORTED');
  const joined = source.map(partText).filter((value) => value !== undefined).join('');
  locateEntries(joined, entries);
}

/**
 * Replace captured tokens in one user message.
 * @param {object} options `content`, `entries`, and `buildInsert(entry, part)`
 *   returning the parts to insert at the token position.
 * @returns {Array} projected content parts.
 */
export function replaceVideoTokens({ content, entries, buildInsert }) {
  const source = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  if (!Array.isArray(source)) throw failure('provider user content is unsupported', 'VIDEO_SDK_UNSUPPORTED');
  const joined = source.map(partText).filter((value) => value !== undefined).join('');
  const locations = locateEntries(joined, entries);
  let cursor = 0;
  let textOffset = 0;
  const output = [];
  for (const part of source) {
    const value = partText(part);
    if (value === undefined) { output.push(part); continue; }
    let offset = 0;
    while (cursor < locations.length) {
      const entry = locations[cursor];
      if (entry.start >= textOffset + value.length) break;
      const index = entry.start - textOffset;
      if (index < offset || entry.end > textOffset + value.length) {
        throw failure('the provider split or reordered a captured video token', 'VIDEO_SDK_UNSUPPORTED');
      }
      if (index > offset) output.push({ ...part, text: value.slice(offset, index) });
      output.push(...buildInsert(entry, part));
      offset = index + entry.needle.length;
      cursor++;
    }
    if (offset === 0) output.push(part);
    else if (offset < value.length) output.push({ ...part, text: value.slice(offset) });
    textOffset += value.length;
  }
  if (cursor !== locations.length) {
    throw failure('the provider projection no longer contains the captured file handle or URL', 'VIDEO_SDK_UNSUPPORTED');
  }
  return output;
}
