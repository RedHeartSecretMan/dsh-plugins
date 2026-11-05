/**
 * Provider payload projection for session-video-intake.
 *
 * `capture.js` records the user's original video blocks before core projects
 * them to file-handle text. The hook below then decides how the current route
 * can consume them: native `video_url`, a storyboard image fallback, or an
 * explicit failure. It never registers a provider.
 * @module session-video-intake/payload
 */
import { checkAbort, failure } from './failure.js';
import { fileVideo } from './native-video.js';
import { currentScope } from './request-scope.js';
import { assertVideoTokens, partText, replaceVideoTokens, sdkText } from './rewrite-tokens.js';

export { createVideoMiddleware } from './capture.js';
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

function nativeVideoPart(shapeKind, url) {
  if (shapeKind === 'responses') return { type: 'input_video', video_url: url };
  return { type: 'video_url', video_url: { url } };
}

/** Replace captured handles with native video parts for either OpenAI shape. */
async function rewriteNativePayload(payload, scope, limits, signal, sdkUsers, shapeKind) {
  checkAbort(signal);
  const shape = payloadShape(payload);
  if (!shape || (shapeKind !== 'completions' && shapeKind !== 'responses')) {
    throw failure('the provider payload has an unknown shape', 'VIDEO_SDK_UNSUPPORTED');
  }
  const cache = new Map();
  let totalBytes = 0;
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
    assertVideoTokens(source, entries);

    const resolved = [];
    for (const entry of entries) {
      if (++count > limits.maxVideos) throw failure('request exceeds maxVideos', 'VIDEO_LIMIT');
      let url = entry.url;
      if (entry.ref) {
        totalBytes += entry.ref.bytes;
        if (totalBytes > limits.maxTotalVideoBytes) throw failure('request exceeds maxTotalVideoBytes', 'VIDEO_LIMIT');
        const key = JSON.stringify(entry.ref);
        if (!cache.has(key)) cache.set(key, fileVideo(entry.ref, scope, limits, signal));
        url = await cache.get(key);
      }
      resolved.push({ ...entry, videoUrl: url });
    }

    const content = replaceVideoTokens({
      content: source,
      entries: resolved,
      buildInsert: (entry) => [nativeVideoPart(shape.kind, entry.videoUrl)],
    });
    items.push({ ...item, content });
  }
  if (userIndex < scope.plans.length || count === 0) throw failure('provider user message projection changed', 'VIDEO_SDK_UNSUPPORTED');
  checkAbort(signal);
  return shape.apply(items);
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
    assertVideoTokens(source, entries);

    const artifacts = [];
    for (const entry of entries) {
      artifacts.push(await storyboardForEntry(entry, scope, limits, signal, storyboard, cache));
    }
    const decorated = entries.map((entry, index) => ({ ...entry, artifact: artifacts[index] }));
    const content = replaceVideoTokens({
      content: source,
      entries: decorated,
      buildInsert: (entry, part) => [{ ...part, text: `\n${entry.artifact.manifest}\n` }],
    });
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
        if (capability.video) {
          if (shape?.kind === 'completions' || shape?.kind === 'responses') {
            return rewriteNativePayload(base, scope, limits, signal, sdkUsers, shape.kind);
          }
          throw failure(
            `cannot process video: ${capability.provider}/${capability.model} declares native video, but the ${shape?.kind ?? 'unknown'} payload shape cannot carry video`,
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
