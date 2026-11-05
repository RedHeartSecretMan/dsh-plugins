/**
 * Capture user video inputs before core projects FileBlocks to text.
 * @module session-video-intake/capture
 */
import { failure } from './failure.js';
import { findBareVideoUrls, videoExtension } from './media-input.js';
import { currentScope, isolatedStream, scopedStream } from './request-scope.js';

// Count occurrences in the source projection so quoted identical handles or
// URLs remain text even when the same value is also a genuine video input.
function occurrenceBefore(text, needle, end = text.length) {
  let count = 0;
  for (let offset = 0; offset < end;) {
    const index = text.indexOf(needle, offset);
    if (index < 0 || index >= end) break;
    count++;
    offset = index + needle.length;
  }
  return count;
}

/**
 * Record user video blocks and bare video URLs before core's file projection.
 * Runs for every provider: the payload hook later decides whether the route can
 * consume video natively, needs a storyboard, or cannot accept it at all.
 */
export function createVideoMiddleware(ctx) {
  return function sessionVideoIntakeMiddleware(options, next) {
    const plans = [];
    for (const message of options.messages) {
      if (message.role !== 'user') continue;
      const entries = [];
      let projection = '';
      for (const block of message.content) {
        if (block.type === 'file') {
          const eligible = videoExtension(block.attachment?.name);
          if (eligible && typeof ctx.llm?.fileRequestText !== 'function') {
            throw failure('the running Harness does not expose llm.fileRequestText', 'VIDEO_SDK_UNSUPPORTED');
          }
          const needle = ctx.llm?.fileRequestText?.(block.attachment) ?? '';
          if (eligible) {
            if (!needle) throw failure('fileRequestText returned an empty file handle', 'VIDEO_SDK_UNSUPPORTED');
            entries.push({ needle, occurrence: occurrenceBefore(projection, needle), ref: { ...block.attachment } });
          }
          projection += needle;
        } else if (block.type === 'text') {
          const start = projection.length;
          projection += block.text;
          for (const entry of findBareVideoUrls(block.text)) {
            entries.push({ ...entry, occurrence: occurrenceBefore(projection, entry.needle, start + entry.offset) });
          }
        }
      }
      plans.push(entries);
    }
    if (!plans.some((entries) => entries.length)) {
      return currentScope() ? isolatedStream(next) : next();
    }
    const scope = {
      plans,
      provider: options.provider,
      model: options.model,
      attachments: () => ctx.get?.('attachments') ?? ctx.attachments,
      signal: options.signal,
    };
    return scopedStream(scope, next);
  };
}
