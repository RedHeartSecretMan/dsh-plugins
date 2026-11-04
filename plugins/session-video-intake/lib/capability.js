/**
 * Per-route video intake capability.
 *
 * The Harness exposes `inputModalities` for images but never `video`, so native
 * video comes from one of two sources:
 *
 *   1. `videoRoutes` — an explicit override whitelist (also `[]` to disable);
 *   2. when `videoRoutes` is unset, a fail-soft catalog probe for a backend that
 *      declares `video` in its model listing.
 *
 * Capability is cached per provider/model and cleared when the adapter topology
 * changes, which also drops the probe's own cache.
 * @module session-video-intake/capability
 */
import { failure } from './payload.js';
import { createCatalogProbe, providerProfile } from './catalog.js';

export function providerPiProvider(ctx, provider) {
  const candidate = providerProfile(ctx, provider)?.piProvider;
  return typeof candidate?.streamSimple === 'function' ? candidate : undefined;
}

/**
 * Resolve `video` / `image` / `injectable` for one exact provider/model.
 * @param {object} ctx plugin context.
 * @param {object} options `videoRoutes` as an explicit Set (or undefined), plus
 *   validated `catalogProbe` settings and optional test seams.
 */
export function createCapabilityResolver(ctx, { videoRoutes, catalogProbe = {}, fetchImpl, now } = {}) {
  const explicit = videoRoutes instanceof Set ? videoRoutes : undefined;
  const probe = explicit === undefined && catalogProbe.enabled !== false
    ? createCatalogProbe(ctx, {
      ...catalogProbe,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      ...(now === undefined ? {} : { now }),
    })
    : undefined;
  const cache = new Map();

  const lookup = async (provider, model) => {
    if (typeof provider !== 'string' || typeof model !== 'string') {
      return { provider, model, video: false, image: false, injectable: false, reason: 'route-missing' };
    }
    const injectable = Boolean(providerPiProvider(ctx, provider));
    let modalities = [];
    if (typeof ctx.llm?.resolveModelInfo === 'function') {
      try {
        const info = await ctx.llm.resolveModelInfo(provider, model);
        modalities = Array.isArray(info?.inputModalities) ? info.inputModalities : [];
      } catch {
        modalities = [];
      }
    }
    const video = explicit !== undefined
      ? explicit.has(`${provider}/${model}`)
      : probe !== undefined ? await probe.declaresVideo(provider, model) : false;
    return {
      provider,
      model,
      video,
      image: modalities.includes('image'),
      injectable,
      reason: !injectable ? 'provider-not-injectable' : video ? 'native-video' : modalities.includes('image') ? 'image-storyboard' : 'no-media-capability',
    };
  };

  return {
    async get(provider, model) {
      const key = `${provider}\u0000${model}`;
      if (!cache.has(key)) cache.set(key, await lookup(provider, model));
      return cache.get(key);
    },
    clear() {
      cache.clear();
      probe?.clear();
    },
  };
}

/** Fail early, before `prepareCall()`, when a video cannot reach this route. */
export function assertVideoCapability(capability) {
  // A route that cannot be injected never receives a payload hook, so a video
  // sent to it would silently become a file-handle text block. Reject it even
  // when the model metadata claims video or image support.
  if (!capability?.injectable) {
    const detail = capability?.reason === 'route-missing'
      ? 'the current request has no provider/model route'
      : `provider "${capability?.provider}" does not expose an injectable chat-completions adapter`;
    throw failure(`cannot process video: ${detail}`, 'VIDEO_UNSUPPORTED');
  }
  if (capability.video || capability.image) return capability;
  throw failure(
    `cannot process video: model "${capability.provider}/${capability.model}" supports neither native video nor image input`,
    'VIDEO_UNSUPPORTED',
  );
}
