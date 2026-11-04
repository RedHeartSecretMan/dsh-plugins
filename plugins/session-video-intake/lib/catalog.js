/**
 * Best-effort discovery of a route's declared input modalities.
 *
 * The Harness model metadata has no `video` modality (`inputModalities` can only
 * be text/image), so the only place a backend may declare video input is its own
 * model listing. Some OpenAI-compatible gateways expose that as
 * `modalities.input`; plain OpenAI/vLLM listings do not, and then the probe is
 * simply unknown. Every failure is treated as "no declaration": callers fall
 * back to image handling and never block a request on discovery.
 * @module session-video-intake/catalog
 */
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_TTL_MS = 300000;

/** The resolved pi-ai profile for one provider, when this adapter owns it. */
export function providerProfile(ctx, provider) {
  const registration = ctx.llm?.adapters?.get?.(provider);
  const adapter = registration?.adapter;
  const profiles = typeof adapter?.config?.profiles === 'function' ? adapter.config.profiles() : undefined;
  return profiles?.get?.(provider);
}

/** The listing endpoint for an OpenAI-compatible route, if one is known. */
export function listingUrl(baseURL, api) {
  if (typeof baseURL !== 'string' || !/^https?:\/\//i.test(baseURL)) return undefined;
  if (typeof api !== 'string' || !api.startsWith('openai')) return undefined;
  return `${baseURL.replace(/\/+$/, '')}/models`;
}

function declaredInputs(entry) {
  for (const list of [entry?.modalities?.input, entry?.input_modalities, entry?.architecture?.input_modalities]) {
    if (Array.isArray(list)) return list;
  }
  return undefined;
}

/** True only when the catalog entry explicitly lists `video` as an input. */
export function declaresVideo(entry) {
  const inputs = declaredInputs(entry);
  return Array.isArray(inputs) && inputs.includes('video');
}

/** Resolve the route's credential through the Host service, then the environment. */
async function resolveCredential(ctx, profile) {
  const ref = profile?.apiKeyEnv;
  if (typeof ref !== 'string' || ref.length === 0) return undefined;
  try {
    const credentials = ctx.get?.('credentials');
    const hit = credentials && typeof credentials.resolve === 'function' ? await credentials.resolve(ref) : undefined;
    if (typeof hit?.value === 'string' && hit.value.length > 0) return hit.value;
  } catch {
    // Fall through to the process environment; probing must never fail the turn.
  }
  const env = typeof process === 'undefined' ? undefined : process.env?.[ref];
  return typeof env === 'string' && env.length > 0 ? env : undefined;
}

/**
 * Create a cached, fail-soft catalog probe.
 * @param {object} ctx the plugin context (needs `llm` and optionally `credentials`).
 * @param {object} [options] timeouts, cache TTL and injectable fetch/clock for tests.
 * @returns {{declaresVideo: (provider: string, model: string) => Promise<boolean>, clear: () => void}}
 */
export function createCatalogProbe(ctx, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    ttlMs = DEFAULT_TTL_MS,
    fetchImpl = globalThis.fetch,
    now = Date.now,
  } = options;
  const cache = new Map();
  const usable = typeof fetchImpl === 'function';

  const probeRoute = async (provider, model) => {
    const profile = providerProfile(ctx, provider);
    const url = listingUrl(profile?.baseURL, profile?.api);
    if (url === undefined) return false;
    const headers = { accept: 'application/json', ...(profile?.headers ?? {}) };
    const key = await resolveCredential(ctx, profile);
    if (key !== undefined && headers.authorization === undefined && headers.Authorization === undefined) {
      headers.authorization = `Bearer ${key}`;
    }
    const response = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response?.ok) return false;
    const body = await response.json();
    const entries = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    const entry = entries.find((candidate) => candidate?.id === model);
    return entry === undefined ? false : declaresVideo(entry);
  };

  return {
    async declaresVideo(provider, model) {
      if (!usable || typeof provider !== 'string' || typeof model !== 'string') return false;
      const key = `${provider}\u0000${model}`;
      const at = now();
      const hit = cache.get(key);
      if (hit !== undefined && hit.expiresAt > at) return hit.promise;
      const promise = probeRoute(provider, model).catch(() => false);
      cache.set(key, { expiresAt: at + ttlMs, promise });
      return promise;
    },
    clear() {
      cache.clear();
    },
  };
}
