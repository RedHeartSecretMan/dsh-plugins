import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createVideoMiddleware, installPayloadHook } from '../lib/payload.js';

const baseLimits = (overrides = {}) => ({
  maxVideoBytes: 64 * 1024 * 1024,
  maxTotalVideoBytes: 64 * 1024 * 1024,
  maxVideos: 8,
  ...overrides,
});

function freeze(value) {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !(value instanceof AbortSignal)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
const text = (value) => ({ type: 'text', text: value });
const user = (...content) => ({ role: 'user', content });
const file = (attachment) => ({ type: 'file', attachment });
function mp4(tail = 'session-video-byte-fixture') {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(24);
  header.write('ftypisom', 4, 'ascii');
  header.write('isommp42', 16, 'ascii');
  return Buffer.concat([header, Buffer.from(tail)]);
}
const webm = () => Buffer.from('1a45dfa3874282847765626d18538067010203', 'hex');
function refFor(data, name = 'clip.mp4') {
  return freeze({ attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`, name, bytes: data.length });
}
function handle(ref) {
  return `[File ${JSON.stringify(ref.name)} (${ref.bytes} bytes, sha256:${ref.attachmentId.slice(7, 15)}): verbatim read-only copy saved at ${JSON.stringify(`/durable/${ref.attachmentId}/${ref.name}`)}. Read that path with your file tools.]`;
}

const PROVIDER = 'magpie';
const MODEL = 'video-model';

function fixture({
  data = mp4(),
  name = 'clip.mp4',
  limits = {},
  read,
  wire,
  video = true,
  image = true,
  storyboard = true,
  shape = 'completions',
} = {}) {
  const attachment = refFor(data, name);
  const reads = [];
  const calls = [];
  const payloads = [];
  const originals = [];
  const objects = new Map([[attachment.attachmentId, data]]);
  const attachments = {
    async *readFileStream(ref, signal) {
      reads.push({ ref, signal });
      if (read) { yield* read(ref, signal); return; }
      const bytes = objects.get(ref.attachmentId);
      assert.ok(bytes);
      yield bytes.subarray(0, 7);
      await tick();
      signal?.throwIfAborted();
      yield bytes.subarray(7);
    },
  };
  const ctx = { llm: { fileRequestText: handle, adapters: new Map() }, get: (key) => key === 'attachments' ? attachments : undefined };
  const capabilities = {
    async get(provider, model) { return { provider, model, video, image, injectable: true }; },
  };
  const builder = storyboard
    ? { build: async ({ source, name: sourceName }) => ({ png: Buffer.from(`storyboard:${sourceName}:${source.kind}`), manifest: `[分镜 ${sourceName}]` }) }
    : undefined;
  const projectedText = (message) => typeof message.content === 'string'
    ? message.content
    : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
  const toInitial = (model, context) => {
    if (shape === 'responses') {
      return freeze({
        model: model.id,
        input: context.messages.map((message) => ({
          role: message.role,
          content: [{ type: 'input_text', text: projectedText(message) }],
        })),
        stream: true,
      });
    }
    return freeze({ model: model.id, messages: context.messages, tools: context.tools, stream: true });
  };
  const piProvider = {
    getModels: () => [{ id: MODEL, provider: PROVIDER, api: 'openai-completions', maxTokens: 4096 }],
    streamSimple(model, context, options) {
      calls.push({ model, context, options });
      return (async function* () {
        await tick();
        const initial = toInitial(model, context);
        originals.push(initial);
        const payload = await options?.onPayload?.(initial, model) ?? initial;
        payloads.push(payload);
        if (wire) await wire(payload);
        yield { type: 'text-delta', text: 'sdk output' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  installPayloadHook(piProvider, { limits: baseLimits(limits), capabilities, storyboard: builder });
  const middleware = createVideoMiddleware(ctx);
  const options = (messages, overrides = {}) => freeze({ provider: PROVIDER, model: MODEL, messages, ...overrides });
  function stream(input) {
    return middleware(input, () => (async function* () {
      // The real core projects every file block into its handle text first.
      const messages = input.messages.map((message) => ({
        ...message,
        content: Array.isArray(message.content)
          ? message.content.map((block) => block.type === 'file' ? text(handle(block.attachment)) : block)
          : message.content,
      }));
      yield* piProvider.streamSimple({ id: input.model, provider: PROVIDER }, { messages, tools: input.tools }, freeze({ signal: input.signal }));
    })());
  }
  return { attachment, objects, reads, calls, payloads, originals, options, stream };
}
async function collect(stream) { return Array.fromAsync(stream); }
function videos(payload) {
  return payload.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === 'video_url') : []);
}
function images(payload) {
  return payload.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url') : []);
}
function bytesOf(part) { return Buffer.from(part.video_url.url.split(',')[1], 'base64'); }

test('native route: original file bytes become video_url', async () => {
  const data = mp4('exact bytes\u0000\u0001\u00ff');
  const f = fixture({ data });
  const request = f.options([user(text('before '), file(f.attachment), text(' after'))]);
  const chunks = await collect(f.stream(request));
  assert.equal(chunks[0].text, 'sdk output');
  assert.equal(videos(f.payloads[0]).length, 1);
  assert.deepEqual(bytesOf(videos(f.payloads[0])[0]), data);
  assert.match(videos(f.payloads[0])[0].video_url.url, /^data:video\/mp4;base64,/);
  assert.deepEqual(f.payloads[0].messages[0].content.map((part) => part.type), ['text', 'video_url', 'text']);
  assert.equal(request.messages[0].content[1].type, 'file', 'durable message is never rewritten');
  assert.equal(f.reads.length, 1);
});

test('native route: the rewritten payload reaches a real HTTP request with identical bytes', async (t) => {
  let received;
  const server = createServer(async (request, response) => {
    received = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString());
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const data = mp4('wire bytes');
  const f = fixture({ data, wire: async (payload) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
  } });
  await collect(f.stream(f.options([user(file(f.attachment))])));
  assert.deepEqual(bytesOf(videos(received)[0]), data);
});

test('native route: WebM uses a content-validated MIME and unchanged bytes', async () => {
  const data = webm();
  const f = fixture({ data, name: 'original.WEBM' });
  await collect(f.stream(f.options([user(file(f.attachment))])));
  assert.match(videos(f.payloads[0])[0].video_url.url, /^data:video\/webm;base64,/);
  assert.deepEqual(bytesOf(videos(f.payloads[0])[0]), data);
});

test('bare video URLs are preserved and non-video links stay text', async () => {
  const f = fixture();
  await collect(f.stream(f.options([user(
    text('a https://cdn.invalid/first.mp4 then '),
    file(f.attachment),
    text(' b [clip](https://cdn.invalid/link.mp4) `https://cdn.invalid/code.webm` c'),
  )])));
  const urls = videos(f.payloads[0]).map((part) => part.video_url.url.startsWith('data:') ? 'file' : part.video_url.url);
  assert.deepEqual(urls, ['https://cdn.invalid/first.mp4', 'file']);
});

test('a request without video is passed through untouched', async () => {
  const f = fixture();
  const request = f.options([user(text('ordinary text https://cdn.invalid/image.png'))]);
  await collect(f.stream(request));
  assert.equal(f.payloads[0], f.originals[0]);
  assert.equal(f.reads.length, 0);
});

test('a non-video attachment keeps the core file handle and reads no bytes', async () => {
  const f = fixture({ data: Buffer.from('plain text'), name: 'notes.txt' });
  await collect(f.stream(f.options([user(file(f.attachment))])));
  assert.equal(f.payloads[0], f.originals[0]);
  const content = f.payloads[0].messages[0].content;
  const projected = typeof content === 'string' ? content : content.filter((part) => part.type === 'text').map((part) => part.text).join('');
  assert.equal(projected, handle(f.attachment));
  assert.equal(f.reads.length, 0);
});

test('overlapping requests keep separate scopes', async () => {
  const f = fixture();
  const secondData = mp4('second video bytes');
  const second = refFor(secondData, 'second.mp4');
  f.objects.set(second.attachmentId, secondData);
  await Promise.all([
    collect(f.stream(f.options([user(text('one'), file(f.attachment))]))),
    collect(f.stream(f.options([user(text('two'), file(second))]))),
  ]);
  for (const payload of f.payloads) {
    const expected = payload.messages[0].content[0].text === 'one' ? f.objects.get(f.attachment.attachmentId) : secondData;
    assert.deepEqual(bytesOf(videos(payload)[0]), expected);
  }
});

test('repeated identical references read once per request', async () => {
  const f = fixture();
  await collect(f.stream(f.options([user(file(f.attachment), text(' versus '), file(f.attachment))])));
  assert.equal(f.reads.length, 1);
  assert.equal(videos(f.payloads[0]).length, 2);
});

test('file, aggregate and count limits fail before any payload', async () => {
  const perFile = fixture({ limits: { maxVideoBytes: 4 } });
  await assert.rejects(collect(perFile.stream(perFile.options([user(file(perFile.attachment))]))), { code: 'VIDEO_LIMIT' });
  assert.equal(perFile.payloads.length, 0);

  const aggregate = fixture({ limits: { maxTotalVideoBytes: 4 } });
  await assert.rejects(collect(aggregate.stream(aggregate.options([user(file(aggregate.attachment))]))), { code: 'VIDEO_LIMIT' });
  const count = fixture({ limits: { maxVideos: 1 } });
  await assert.rejects(collect(count.stream(count.options([user(file(count.attachment), file(count.attachment))]))), { code: 'VIDEO_LIMIT' });
});

test('containers are verified instead of trusting the file name', async () => {
  for (const [data, name, label] of [
    [Buffer.from('not a video'), 'fake.mp4', 'text named MP4'],
    [mp4(), 'fake.webm', 'MP4 named WebM'],
    [Buffer.from('1a45dfa3874282846d6174726f736b61', 'hex'), 'fake.webm', 'Matroska named WebM'],
  ]) {
    const f = fixture({ data, name });
    await assert.rejects(collect(f.stream(f.options([user(file(f.attachment))]))), { code: 'VIDEO_INVALID_MEDIA' }, label);
    assert.equal(f.payloads.length, 0);
  }
});

test('attachment integrity and abort failures propagate before the payload', async () => {
  const corrupt = fixture({ read: async function* () {
    yield Buffer.from(mp4().subarray(0, 4));
    throw Object.assign(new Error('checksum mismatch'), { code: 'ATTACHMENT_CORRUPT' });
  } });
  await assert.rejects(collect(corrupt.stream(corrupt.options([user(file(corrupt.attachment))]))), { code: 'ATTACHMENT_CORRUPT' });

  const mismatched = fixture({ read: async function* () { yield Buffer.from('wrong bytes entirely'); } });
  await assert.rejects(collect(mismatched.stream(mismatched.options([user(file(mismatched.attachment))]))), { code: 'VIDEO_INVALID_MEDIA' });

  for (const during of [false, true]) {
    const controller = new AbortController();
    const f = fixture({ read: async function* (_ref, signal) {
      assert.ok(signal instanceof AbortSignal);
      yield mp4().subarray(0, 7);
      controller.abort('test cancelled');
      yield mp4().subarray(7);
    } });
    if (!during) controller.abort();
    await assert.rejects(collect(f.stream(f.options([user(file(f.attachment))], { signal: controller.signal }))), { code: 'ABORTED' });
    assert.equal(f.payloads.length, 0);
  }
});

test('quoted identical URLs keep their original text position', async () => {
  const f = fixture();
  const url = 'https://cdn.invalid/repeated.mp4';
  const prefix = `\`${url}\` [clip](${url}) ${handle(f.attachment)} literal end `;
  await collect(f.stream(f.options([user(text(prefix), file(f.attachment), text(` then ${url} end`))])));
  const content = f.payloads[0].messages[0].content;
  assert.equal(content[0].text, prefix);
  assert.equal(content[1].type, 'video_url');
  assert.equal(content[3].video_url.url, url);
});

test('image-only route: the handle becomes a storyboard manifest plus image part', async () => {
  const f = fixture({ video: false, image: true });
  const request = f.options([user(text('before '), file(f.attachment), text(' after'))]);
  await collect(f.stream(request));
  const payload = f.payloads[0];
  assert.equal(videos(payload).length, 0);
  const parts = payload.messages[0].content;
  assert.deepEqual(parts.map((part) => part.type), ['text', 'text', 'text', 'image_url']);
  assert.equal(parts[0].text, 'before ');
  assert.match(parts[1].text, /分镜 clip\.mp4/);
  assert.equal(parts[2].text, ' after');
  assert.match(parts[3].image_url.url, /^data:image\/png;base64,/);
  assert.equal(Buffer.from(parts[3].image_url.url.split(',')[1], 'base64').toString(), 'storyboard:clip.mp4:attachment');
  assert.equal(request.messages[0].content[1].type, 'file', 'durable message is never rewritten');
});

test('image-only route: Responses payload gets input_image parts', async () => {
  const f = fixture({ video: false, image: true, shape: 'responses' });
  await collect(f.stream(f.options([user(file(f.attachment))])));
  const item = f.payloads[0].input[0];
  assert.deepEqual(item.content.map((part) => part.type), ['input_text', 'input_image']);
  assert.match(item.content[0].text, /分镜/);
  assert.match(item.content[1].image_url, /^data:image\/png;base64,/);
  assert.equal(item.content[1].detail, 'auto');
});

test('a Responses route cannot carry native video and fails explicitly', async () => {
  const f = fixture({ video: true, image: true, shape: 'responses' });
  await assert.rejects(
    collect(f.stream(f.options([user(file(f.attachment))]))),
    { code: 'VIDEO_SDK_UNSUPPORTED', message: /cannot carry video_url/ },
  );
  assert.equal(f.payloads.length, 0);
});

test('a route with neither capability fails explicitly', async () => {
  const f = fixture({ video: false, image: false });
  await assert.rejects(collect(f.stream(f.options([user(file(f.attachment))]))), { code: 'VIDEO_UNSUPPORTED' });
  assert.equal(f.payloads.length, 0);
});

test('a disabled storyboard cannot silently drop the video', async () => {
  const f = fixture({ video: false, image: true, storyboard: false });
  await assert.rejects(collect(f.stream(f.options([user(file(f.attachment))]))), { code: 'VIDEO_STORYBOARD_DISABLED' });
});

test('the payload hook only wraps scoped requests', async () => {
  const f = fixture();
  const plain = { messages: [text('plain')] };
  const original = { streamSimple: (model, context) => ({ untouched: context.messages }) };
  const restore = installPayloadHook(original, {
    limits: baseLimits(),
    capabilities: { get: async () => ({ video: true, image: true, injectable: true }) },
    storyboard: { build: async () => ({ png: Buffer.from('x'), manifest: 'x' }) },
  });
  assert.deepEqual(original.streamSimple({ id: MODEL }, { messages: [plain] }), { untouched: [plain] });
  restore();
});
