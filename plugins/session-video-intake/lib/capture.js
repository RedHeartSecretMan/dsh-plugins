/**
 * Capture user video inputs before core projects FileBlocks to text.
 *
 * Three input forms are recorded: durable video FileBlocks, bare HTTP(S) video
 * URLs, and explicit local video references in text (`@<absolute path>` and
 * `file://`). Local references are materialized into durable attachments on the
 * first stream iteration: the `llm/stream` waterfall is synchronous, so the
 * async read/save work is deferred behind an async-iterable wrapper instead of
 * making the listener async.
 * @module session-video-intake/capture
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { checkAbort, failure } from './failure.js';
import { findBareVideoUrls, findVideoFileReferences, isVideoAttachment } from './media-input.js';
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

function attachmentStore(ctx) {
  return ctx.get?.('attachments') ?? ctx.attachments;
}

function localLeafName(path) {
  return path.split(/[\\/]/).pop() || path;
}

function localTargetKey(path) {
  try {
    return isAbsolute(path) ? resolve(path) : path;
  } catch {
    return path;
  }
}

function materializationFailure(message, cause) {
  return failure(`cannot materialize the referenced local video: ${message}`, 'VIDEO_UNSUPPORTED_INPUT', cause);
}

/**
 * Read every referenced local file once and commit it as a durable attachment.
 * Byte caps stay in the payload hook; this only returns durable references.
 * @returns {Promise<Map<string, object>>} durable reference per target key.
 */
async function materializeFileReferences(attachments, targets, signal) {
  const refs = new Map();
  for (const [key, target] of targets) {
    checkAbort(signal);
    let data;
    try {
      data = await readFile(target.path);
    } catch (error) {
      throw materializationFailure(`${JSON.stringify(target.path)} is unreadable: ${error?.message ?? error}`, error);
    }
    checkAbort(signal);
    if (data.byteLength === 0) {
      throw materializationFailure(`${JSON.stringify(target.path)} is empty`);
    }
    let ref;
    try {
      ref = await attachments.saveFile({ data, name: target.name });
    } catch (error) {
      throw materializationFailure(`${JSON.stringify(target.path)} could not be stored: ${error?.message ?? error}`, error);
    }
    checkAbort(signal);
    if (typeof ref?.attachmentId !== 'string' || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) {
      throw materializationFailure('the attachment service returned an invalid durable file reference');
    }
    refs.set(key, ref);
  }
  return refs;
}

/**
 * Delay `next()` until async preparation finishes, then let the ordinary
 * request scope bind every iterator operation. The host waterfall is
 * synchronous, so the returned value must already be an async iterable.
 */
function deferredScopedStream(prepare, next) {
  return {
    [Symbol.asyncIterator]() {
      let inner;
      const stream = () => {
        inner ??= prepare().then((scope) => scopedStream(scope, next)[Symbol.asyncIterator]());
        return inner;
      };
      return {
        async next(value) {
          return (await stream()).next(value);
        },
        async return(value) {
          if (inner === undefined) return { done: true, value };
          return (await inner).return(value);
        },
        async throw(error) {
          if (inner === undefined) return Promise.reject(error);
          return (await inner).throw(error);
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  };
}

function resolvedPlans(plans, refs) {
  return plans.map((entries) => entries.map((entry) => {
    if (entry.localRef === undefined) return entry;
    const { localRef, ...rest } = entry;
    return { ...rest, ref: refs.get(localRef) };
  }));
}

/**
 * Record user video blocks, bare video URLs, and materialized local video
 * references before core's file projection. Runs for every provider: the
 * payload hook later decides whether the route can consume video natively,
 * needs a storyboard, or cannot accept it at all.
 */
export function createVideoMiddleware(ctx) {
  return function sessionVideoIntakeMiddleware(options, next) {
    const plans = [];
    const targets = new Map();
    for (const message of options.messages) {
      if (message.role !== 'user') continue;
      const entries = [];
      let projection = '';
      for (const block of message.content) {
        if (block.type === 'file') {
          const eligible = isVideoAttachment(block.attachment);
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
          const references = [
            ...findBareVideoUrls(block.text),
            ...findVideoFileReferences(block.text),
          ].sort((left, right) => left.offset - right.offset);
          for (const reference of references) {
            const occurrence = occurrenceBefore(projection, reference.needle, start + reference.offset);
            if (reference.path === undefined) {
              entries.push({ ...reference, occurrence });
              continue;
            }
            const key = localTargetKey(reference.path);
            entries.push({ needle: reference.needle, occurrence, localRef: key });
            if (!targets.has(key)) targets.set(key, { path: reference.path, name: localLeafName(reference.path) });
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
      attachments: () => attachmentStore(ctx),
      signal: options.signal,
    };
    if (targets.size === 0) return scopedStream(scope, next);

    const attachments = attachmentStore(ctx);
    if (typeof attachments?.saveFile !== 'function') {
      throw failure(
        'the running Harness does not expose an attachment store for local video references',
        'VIDEO_UNSUPPORTED_INPUT',
      );
    }
    return deferredScopedStream(async () => {
      const refs = await materializeFileReferences(attachments, targets, options.signal);
      return { ...scope, plans: resolvedPlans(plans, refs) };
    }, next);
  };
}
