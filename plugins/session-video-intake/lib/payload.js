/**
 * Request payload projection for session-video-intake.
 *
 * DSH core projects every durable `file` block into file-handle text before an
 * adapter sees the request. `llm/stream` runs before that projection, so the
 * middleware records the user's original video blocks, and the provider payload
 * hook below decides how the current route can consume them:
 *
 *   native video  → replace the handle text with `video_url`
 *   image only    → build a storyboard and replace the handle text with a
 *                   manifest plus image parts
 *   neither       → fail explicitly; never silently send a file path
 *
 * The plugin does not register a provider: hooks are attached to the providers
 * the profile already has.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { findBareVideoUrls, videoExtension } from './media-input.js';

const requests = new AsyncLocalStorage();

export function failure(message, code = 'VIDEO_INVALID_CONFIG') {
  return Object.assign(new Error(`session-video-intake: ${message}`), { code });
}

/** The request scope currently bound to the executing model stream, if any. */
export function currentScope() {
  return requests.getStore();
}

function checkAbort(signal) {
  if (signal?.aborted) throw failure('request aborted', 'ABORTED');
}

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

function scopedStream(scope, next) {
  return {
    [Symbol.asyncIterator]() {
      let iterator;
      const invoke = (method, value) => requests.run(scope, () => {
        // Construction and EVERY deferred operation must use the request scope.
        iterator ??= next()[Symbol.asyncIterator]();
        if (!iterator[method]) {
          if (method === 'throw') return Promise.reject(value);
          return Promise.resolve({ done: true, value });
        }
        return iterator[method](value);
      });
      return {
        next: (value) => invoke('next', value),
        return: (value) => invoke('return', value),
        throw: (value) => invoke('throw', value),
        [Symbol.asyncIterator]() { return this; },
      };
    },
  };
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
      // A nested text-only call must not inherit the outer call's video plan.
      return requests.getStore() ? scopedStream(undefined, next) : next();
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

function mediaType(name, data) {
  if (videoExtension(name) === 'mp4' && data.length >= 16 && data.toString('ascii', 4, 8) === 'ftyp') {
    const size = data.readUInt32BE(0);
    const major = data.toString('ascii', 8, 12);
    const videoBrand = /^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV|qt  )$/;
    if (size >= 16 && size <= data.length && size % 4 === 0 && videoBrand.test(major)) return 'video/mp4';
  }
  if (videoExtension(name) === 'webm' && data.length >= 8 && data.readUInt32BE(0) === 0x1a45dfa3) {
    // EBML header must explicitly declare DocType=webm; Matroska is different.
    const vint = (offset) => {
      const first = data[offset];
      if (!first) return;
      let length = 1;
      while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
      if (length > 8 || offset + length > data.length) return;
      let value = first & (0xff >> length);
      for (let i = 1; i < length; i++) value = value * 256 + data[offset + i];
      return { length, value };
    };
    const header = vint(4);
    if (header && Number.isSafeInteger(header.value) && header.value <= data.length - 4 - header.length) {
      const end = 4 + header.length + header.value;
      for (let offset = 4 + header.length; offset < end;) {
        const first = data[offset];
        let length = 1;
        while (length <= 4 && !(first & (0x80 >> (length - 1)))) length++;
        if (length > 4 || offset + length >= end) break;
        const id = data.subarray(offset, offset + length).toString('hex');
        const size = vint(offset + length);
        if (!size || !Number.isSafeInteger(size.value)) break;
        offset += length + size.length;
        if (offset + size.value > end) break;
        if (id === '4282' && data.toString('ascii', offset, offset + size.value) === 'webm') return 'video/webm';
        offset += size.value;
      }
    }
  }
  throw failure(`attachment ${JSON.stringify(name)} does not contain the declared MP4/WebM container`, 'VIDEO_INVALID_MEDIA');
}

async function fileVideo(ref, scope, limits, signal) {
  if (!/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId ?? '') || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) {
    throw failure('invalid durable file reference', 'VIDEO_INVALID_MEDIA');
  }
  if (ref.bytes > limits.maxVideoBytes) throw failure('video exceeds maxVideoBytes', 'VIDEO_LIMIT');
  const attachments = scope.attachments();
  if (typeof attachments?.readFileStream !== 'function') throw failure('durable attachments.readFileStream is required', 'VIDEO_SDK_UNSUPPORTED');
  const chunks = [];
  const hash = createHash('sha256');
  let bytes = 0;
  checkAbort(signal);
  // Exhaust the stream before sending: attachment-local validates integrity at EOF.
  for await (const chunk of attachments.readFileStream(ref, signal)) {
    checkAbort(signal);
    if (!(chunk instanceof Uint8Array)) throw failure('attachment stream returned non-byte data', 'VIDEO_INVALID_MEDIA');
    bytes += chunk.byteLength;
    if (bytes > limits.maxVideoBytes || bytes > ref.bytes) throw failure('video exceeds its byte bound', 'VIDEO_LIMIT');
    const copy = Buffer.from(chunk);
    chunks.push(copy);
    hash.update(copy);
  }
  checkAbort(signal);
  if (bytes !== ref.bytes || `sha256:${hash.digest('hex')}` !== ref.attachmentId) throw failure('attachment failed byte count or SHA-256 integrity verification', 'VIDEO_INVALID_MEDIA');
  const data = Buffer.concat(chunks, bytes);
  return `data:${mediaType(ref.name, data)};base64,${data.toString('base64')}`;
}

function sdkText(content) {
  const text = typeof content === 'string' ? content
    : (content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function partText(part) {
  return typeof part?.text === 'string' ? part.text : undefined;
}

function payloadShape(payload) {
  if (Array.isArray(payload?.messages)) {
    return { kind: 'completions', items: payload.messages, apply: (items) => ({ ...payload, messages: items }) };
  }
  if (Array.isArray(payload?.input)) {
    return { kind: 'responses', items: payload.input, apply: (items) => ({ ...payload, input: items }) };
  }
  return undefined;
}

function imagePart(shapeKind, dataUrl) {
  if (shapeKind === 'responses') return { type: 'input_image', detail: 'auto', image_url: dataUrl };
  return { type: 'image_url', image_url: { url: dataUrl } };
}

function textPartLike(part, text) {
  return { ...part, text };
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

/** Replace captured handles with `video_url` parts (OpenAI Chat Completions). */
async function rewriteNativePayload(payload, scope, limits, signal, sdkUsers) {
  checkAbort(signal);
  if (!Array.isArray(payload?.messages)) throw failure('the provider payload has no messages array', 'VIDEO_SDK_UNSUPPORTED');
  const cache = new Map();
  let totalBytes = 0;
  let count = 0;
  let userIndex = 0;
  const messages = [];
  for (const message of payload.messages) {
    if (message.role !== 'user') { messages.push(message); continue; }
    const expected = sdkUsers[userIndex];
    if (!expected || sdkText(message.content) !== sdkText(expected.content)) { messages.push(message); continue; }
    const entries = scope.plans[userIndex++] ?? [];
    if (!entries.length) { messages.push(message); continue; }
    const source = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (!Array.isArray(source)) throw failure('provider user content is unsupported', 'VIDEO_SDK_UNSUPPORTED');
    const joined = source.filter((part) => part.type === 'text').map((part) => part.text).join('');
    const locations = locateEntries(joined, entries);
    let cursor = 0;
    let textOffset = 0;
    const content = [];
    for (const part of source) {
      if (part.type !== 'text') { content.push(part); continue; }
      let offset = 0;
      while (cursor < locations.length) {
        const entry = locations[cursor];
        if (entry.start >= textOffset + part.text.length) break;
        const index = entry.start - textOffset;
        if (index < offset || entry.end > textOffset + part.text.length) throw failure('the provider split or reordered a captured video token', 'VIDEO_SDK_UNSUPPORTED');
        if (++count > limits.maxVideos) throw failure('request exceeds maxVideos', 'VIDEO_LIMIT');
        let url = entry.url;
        if (entry.ref) {
          totalBytes += entry.ref.bytes;
          if (totalBytes > limits.maxTotalVideoBytes) throw failure('request exceeds maxTotalVideoBytes', 'VIDEO_LIMIT');
          const key = JSON.stringify(entry.ref);
          if (!cache.has(key)) cache.set(key, fileVideo(entry.ref, scope, limits, signal));
          url = await cache.get(key);
        }
        if (index > offset) content.push({ ...part, text: part.text.slice(offset, index) });
        content.push({ type: 'video_url', video_url: { url } });
        offset = index + entry.needle.length;
        cursor++;
      }
      if (offset === 0) content.push(part);
      else if (offset < part.text.length) content.push({ ...part, text: part.text.slice(offset) });
      textOffset += part.text.length;
    }
    if (cursor !== entries.length) throw failure('the provider projection no longer contains the captured file handle or URL', 'VIDEO_SDK_UNSUPPORTED');
    messages.push({ ...message, content });
  }
  if (userIndex < scope.plans.length || count === 0) throw failure('provider user message projection changed', 'VIDEO_SDK_UNSUPPORTED');
  checkAbort(signal);
  return { ...payload, messages };
}

async function storyboardForEntry(entry, scope, limits, signal, storyboard, cache) {
  if (entry.ref) {
    if (entry.ref.bytes > limits.maxVideoBytes) throw failure('video exceeds maxVideoBytes', 'VIDEO_LIMIT');
    const key = `ref:${entry.ref.attachmentId}`;
    if (!cache.has(key)) {
      cache.set(key, storyboard.build({
        source: { kind: 'attachment', ref: entry.ref },
        name: entry.ref.name,
        signal,
        attachments: scope.attachments(),
      }));
    }
    return cache.get(key);
  }
  const key = `url:${entry.url}`;
  if (!cache.has(key)) {
    cache.set(key, storyboard.build({
      source: { kind: 'url', url: entry.url },
      name: entry.url.split('/').pop() || 'video',
      signal,
      attachments: scope.attachments(),
    }));
  }
  return cache.get(key);
}

/**
 * Replace captured handles with a storyboard manifest plus image parts, for
 * routes that accept images but not native video. Understands both the OpenAI
 * Chat Completions (`messages`) and Responses (`input`) payload shapes.
 */
async function rewriteStoryboardPayload(payload, scope, limits, signal, sdkUsers, storyboard) {
  checkAbort(signal);
  const shape = payloadShape(payload);
  if (!shape) throw failure('the provider payload has neither messages nor input arrays', 'VIDEO_SDK_UNSUPPORTED');
  if (!storyboard || typeof storyboard.build !== 'function') {
    throw failure('storyboard fallback is disabled, but this route only accepts image input', 'VIDEO_STORYBOARD_DISABLED');
  }
  const cache = new Map();
  let count = 0;
  let userIndex = 0;
  const items = [];
  for (const item of shape.items) {
    if (item?.role !== 'user') { items.push(item); continue; }
    const expected = sdkUsers[userIndex];
    const source = typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : item.content;
    if (!expected || !Array.isArray(source)) { items.push(item); continue; }
    const joined = source.map(partText).filter((value) => value !== undefined).join('');
    if (joined !== sdkText(expected.content)) { items.push(item); continue; }
    const entries = scope.plans[userIndex++] ?? [];
    if (!entries.length) { items.push(item); continue; }
    count += entries.length;
    if (count > limits.maxVideos) throw failure('request exceeds maxVideos', 'VIDEO_LIMIT');
    const locations = locateEntries(joined, entries);
    const artifacts = [];
    for (const entry of locations) {
      artifacts.push(await storyboardForEntry(entry, scope, limits, signal, storyboard, cache));
    }
    let cursor = 0;
    let textOffset = 0;
    const content = [];
    for (const part of source) {
      const value = partText(part);
      if (value === undefined) { content.push(part); continue; }
      let offset = 0;
      while (cursor < locations.length) {
        const entry = locations[cursor];
        if (entry.start >= textOffset + value.length) break;
        const index = entry.start - textOffset;
        if (index < offset || entry.end > textOffset + value.length) throw failure('the provider split or reordered a captured video token', 'VIDEO_SDK_UNSUPPORTED');
        if (index > offset) content.push(textPartLike(part, value.slice(offset, index)));
        const manifest = artifacts[cursor]?.manifest ?? '';
        content.push(textPartLike(part, `\n${manifest}\n`));
        offset = index + entry.needle.length;
        cursor++;
      }
      if (offset === 0) content.push(part);
      else if (offset < value.length) content.push(textPartLike(part, value.slice(offset)));
      textOffset += value.length;
    }
    if (cursor !== locations.length) throw failure('the provider projection no longer contains the captured file handle or URL', 'VIDEO_SDK_UNSUPPORTED');
    for (const artifact of artifacts) {
      if (!artifact?.png) throw failure('the storyboard builder returned no image', 'VIDEO_STORYBOARD_FAILED');
      content.push(imagePart(shape.kind, `data:image/png;base64,${artifact.png.toString('base64')}`));
    }
    items.push({ ...item, content });
  }
  if (userIndex < scope.plans.length || count === 0) throw failure('provider user message projection changed', 'VIDEO_SDK_UNSUPPORTED');
  checkAbort(signal);
  return shape.apply(items);
}

/**
 * Wrap one provider's `streamSimple` with the payload rewrite. Only requests
 * carrying a captured video scope are touched; everything else delegates
 * unchanged. The hook is installed on the already-registered adapter object,
 * so no new provider route is created.
 */
export function installPayloadHook(providerObject, { limits, capabilities, storyboard }) {
  if (typeof providerObject?.streamSimple !== 'function') {
    throw failure('the attached provider does not expose streamSimple', 'VIDEO_SDK_UNSUPPORTED');
  }
  const original = providerObject.streamSimple;
  const wrapped = (model, context, options) => {
    const scope = currentScope();
    if (!scope) return original(model, context, options);
    const signal = scope.signal && options?.signal ? AbortSignal.any([scope.signal, options.signal]) : options?.signal ?? scope.signal;
    const sdkUsers = (context?.messages ?? []).filter((message) => message.role === 'user');
    if (sdkUsers.length !== scope.plans.length) {
      throw failure('provider user transcript changed before payload serialization', 'VIDEO_SDK_UNSUPPORTED');
    }
    return original(model, context, {
      ...options,
      async onPayload(payload, payloadModel) {
        const previous = await options?.onPayload?.(payload, payloadModel);
        const base = previous ?? payload;
        const capability = await capabilities.get(payloadModel?.provider ?? scope.provider, payloadModel?.id ?? scope.model);
        const shape = payloadShape(base);
        if (capability.video && shape?.kind === 'completions') {
          return rewriteNativePayload(base, scope, limits, signal, sdkUsers);
        }
        if (capability.video) {
          // Native video cannot be expressed in the Responses input shape (nor
          // in an unknown adapter shape). Fail instead of silently storyboarding
          // or claiming the route has no media capability.
          throw failure(
            `cannot process video: ${capability.provider}/${capability.model} declares native video, but the ${shape?.kind ?? 'unknown'} payload shape cannot carry video_url`,
            'VIDEO_SDK_UNSUPPORTED',
          );
        }
        if (capability.image) {
          return rewriteStoryboardPayload(base, scope, limits, signal, sdkUsers, storyboard);
        }
        throw failure(
          `cannot process video: ${capability.provider}/${capability.model} supports neither native video nor image input`,
          'VIDEO_UNSUPPORTED',
        );
      },
    });
  };
  providerObject.streamSimple = wrapped;
  return () => {
    if (providerObject.streamSimple === wrapped) providerObject.streamSimple = original;
  };
}
