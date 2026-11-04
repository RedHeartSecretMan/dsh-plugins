import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCapabilityResolver } from '../lib/capability.js';
import { createCatalogProbe, declaresVideo, listingUrl } from '../lib/catalog.js';

const PROVIDER = 'magpie';
const MODEL = 'zhipu/glm-5.3-flash';

function fakeCtx({ baseURL = 'http://127.0.0.1:3425/v1', api = 'openai-completions', apiKeyEnv, credentials, modalities = ['text', 'image'], injectable = true } = {}) {
  const profile = {
    baseURL,
    api,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(injectable ? { piProvider: { streamSimple() {} } } : {}),
  };
  return {
    llm: {
      adapters: new Map([[PROVIDER, { adapter: { config: { profiles: () => new Map([[PROVIDER, profile]]) } } }]]),
      async resolveModelInfo() { return { inputModalities: modalities }; },
    },
    get(name) { return name === 'credentials' ? credentials : undefined; },
  };
}

function fakeFetch(body, { status = 200 } = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (status !== 200) return { ok: false, status };
      return { ok: true, status, async json() { return body; } };
    },
  };
}

test('a catalog entry that declares video is recognized', async () => {
  const body = { data: [{ id: MODEL, modalities: { input: ['text', 'image', 'video'] } }] };
  const { fetch, calls } = fakeFetch(body);
  const credentials = { async resolve(ref) { return ref === 'MAGPIE_GATEWAY_KEY' ? { value: 'secret' } : undefined; } };
  const probe = createCatalogProbe(fakeCtx({ apiKeyEnv: 'MAGPIE_GATEWAY_KEY', credentials }), { fetchImpl: fetch });
  assert.equal(await probe.declaresVideo(PROVIDER, MODEL), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3425/v1/models');
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret');
});

test('declared lists without video, missing entries and missing modalities mean no native video', async () => {
  const cases = [
    { data: [{ id: MODEL, modalities: { input: ['text', 'image'] } }] },
    { data: [{ id: 'other/model', modalities: { input: ['video'] } }] },
    { data: [{ id: MODEL }] },
    { data: [] },
  ];
  for (const body of cases) {
    const { fetch } = fakeFetch(body);
    const probe = createCatalogProbe(fakeCtx(), { fetchImpl: fetch });
    assert.equal(await probe.declaresVideo(PROVIDER, MODEL), false, JSON.stringify(body));
  }
});

test('non-OpenAI routes, missing base URLs and failed requests are unknown, not errors', async () => {
  for (const ctx of [fakeCtx({ api: 'anthropic-messages' }), fakeCtx({ baseURL: 'file:///tmp/models' })]) {
    const { fetch, calls } = fakeFetch({});
    assert.equal(await createCatalogProbe(ctx, { fetchImpl: fetch }).declaresVideo(PROVIDER, MODEL), false);
    assert.equal(calls.length, 0, 'no request without a known listing endpoint');
  }
  const unauthorized = fakeFetch({}, { status: 401 });
  assert.equal(await createCatalogProbe(fakeCtx(), { fetchImpl: unauthorized.fetch }).declaresVideo(PROVIDER, MODEL), false);

  const broken = { async fetch() { throw new Error('network down'); } };
  assert.equal(await createCatalogProbe(fakeCtx(), { fetchImpl: broken.fetch }).declaresVideo(PROVIDER, MODEL), false);
});

test('the probe caches results and honours the TTL and clear()', async () => {
  let clock = 1000;
  const body = { data: [{ id: MODEL, modalities: { input: ['video'] } }] };
  const { fetch, calls } = fakeFetch(body);
  const probe = createCatalogProbe(fakeCtx(), { fetchImpl: fetch, ttlMs: 10000, now: () => clock });
  assert.equal(await probe.declaresVideo(PROVIDER, MODEL), true);
  assert.equal(await probe.declaresVideo(PROVIDER, MODEL), true);
  assert.equal(calls.length, 1, 'a cached answer is reused');
  clock += 10001;
  await probe.declaresVideo(PROVIDER, MODEL);
  assert.equal(calls.length, 2, 'an expired entry is refreshed');
  probe.clear();
  await probe.declaresVideo(PROVIDER, MODEL);
  assert.equal(calls.length, 3, 'clear() drops the cache');
});

test('the environment supplies a credential when the credentials service is absent', async (t) => {
  const previous = process.env.SESSION_VIDEO_PROBE_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.SESSION_VIDEO_PROBE_KEY;
    else process.env.SESSION_VIDEO_PROBE_KEY = previous;
  });
  process.env.SESSION_VIDEO_PROBE_KEY = 'env-secret';
  const { fetch, calls } = fakeFetch({ data: [] });
  const probe = createCatalogProbe(fakeCtx({ apiKeyEnv: 'SESSION_VIDEO_PROBE_KEY' }), { fetchImpl: fetch });
  await probe.declaresVideo(PROVIDER, MODEL);
  assert.equal(calls[0].options.headers.authorization, 'Bearer env-secret');
});

test('listing URL and entry parsing are explicit', () => {
  assert.equal(listingUrl('http://localhost:3425/v1/', 'openai-completions'), 'http://localhost:3425/v1/models');
  assert.equal(listingUrl('http://localhost/v1', 'openai-responses'), 'http://localhost/v1/models');
  assert.equal(listingUrl('http://localhost/v1', 'anthropic-messages'), undefined);
  assert.equal(listingUrl(undefined, 'openai-completions'), undefined);
  assert.equal(declaresVideo({ modalities: { input: ['video'] } }), true);
  assert.equal(declaresVideo({ input_modalities: ['video'] }), true);
  assert.equal(declaresVideo({ architecture: { input_modalities: ['text'] } }), false);
  assert.equal(declaresVideo({}), false);
});

test('an explicit videoRoutes list wins and the probe is never called', async () => {
  const { fetch, calls } = fakeFetch({ data: [{ id: MODEL, modalities: { input: ['video'] } }] });
  const resolver = createCapabilityResolver(fakeCtx(), {
    videoRoutes: new Set([`${PROVIDER}/${MODEL}`]),
    catalogProbe: { enabled: true },
    fetchImpl: fetch,
  });
  const hit = await resolver.get(PROVIDER, MODEL);
  assert.equal(hit.video, true);
  assert.equal(hit.reason, 'native-video');
  assert.equal(calls.length, 0, 'an explicit whitelist disables discovery');

  const other = await resolver.get(PROVIDER, 'not/listed');
  assert.equal(other.video, false);
  assert.equal(other.image, true);
  assert.equal(other.reason, 'image-storyboard');
  assert.equal(calls.length, 0);
});

test('an explicit empty list disables native video without probing', async () => {
  const { fetch, calls } = fakeFetch({ data: [{ id: MODEL, modalities: { input: ['video'] } }] });
  const resolver = createCapabilityResolver(fakeCtx(), {
    videoRoutes: new Set(),
    catalogProbe: { enabled: true },
    fetchImpl: fetch,
  });
  const capability = await resolver.get(PROVIDER, MODEL);
  assert.equal(capability.video, false);
  assert.equal(capability.image, true);
  assert.equal(calls.length, 0);
});

test('unset videoRoutes uses the probe, and a disabled probe stays image-only', async () => {
  const body = { data: [{ id: MODEL, modalities: { input: ['video'] } }] };
  const enabledFetch = fakeFetch(body);
  const enabled = createCapabilityResolver(fakeCtx(), {
    videoRoutes: undefined,
    catalogProbe: { enabled: true },
    fetchImpl: enabledFetch.fetch,
  });
  const native = await enabled.get(PROVIDER, MODEL);
  assert.equal(native.video, true);
  assert.equal(native.reason, 'native-video');
  assert.equal(enabledFetch.calls.length, 1);

  const disabledFetch = fakeFetch(body);
  const disabled = createCapabilityResolver(fakeCtx(), {
    videoRoutes: undefined,
    catalogProbe: { enabled: false },
    fetchImpl: disabledFetch.fetch,
  });
  const capability = await disabled.get(PROVIDER, MODEL);
  assert.equal(capability.video, false);
  assert.equal(capability.image, true);
  assert.equal(capability.reason, 'image-storyboard');
  assert.equal(disabledFetch.calls.length, 0);
});

test('a route whose backend declares no video stays on the image path', async () => {
  const { fetch } = fakeFetch({ data: [{ id: 'vllm/deepseek-flash', modalities: { input: ['text', 'image'] } }] });
  const resolver = createCapabilityResolver(fakeCtx(), {
    videoRoutes: undefined,
    catalogProbe: { enabled: true },
    fetchImpl: fetch,
  });
  const capability = await resolver.get(PROVIDER, 'vllm/deepseek-flash');
  assert.equal(capability.video, false);
  assert.equal(capability.image, true);
  assert.equal(capability.reason, 'image-storyboard');
});
