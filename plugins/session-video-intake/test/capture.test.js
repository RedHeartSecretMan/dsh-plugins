import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createVideoMiddleware } from '../lib/capture.js';
import { currentScope } from '../lib/request-scope.js';

const refFor = (data, name = 'clip.mp4') => ({
  attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`,
  name,
  bytes: data.byteLength,
});

function service({ fail = false } = {}) {
  const saves = [];
  return {
    saves,
    async saveFile(input) {
      saves.push({ data: Buffer.from(input.data), name: input.name });
      if (fail) throw new Error('store unavailable');
      return refFor(Buffer.from(input.data), input.name);
    },
  };
}

function createCtx({ attachments, fileRequestText = (ref) => `[File ${JSON.stringify(ref.name)}]` } = {}) {
  return {
    llm: { fileRequestText },
    get(name) {
      return name === 'attachments' ? attachments : undefined;
    },
  };
}

const text = (value) => ({ type: 'text', text: value });
const file = (attachment) => ({ type: 'file', attachment });
const user = (...content) => ({ role: 'user', content });
const request = (messages, overrides = {}) => ({ provider: 'test-provider', model: 'test-model', messages, ...overrides });

async function run(middleware, options) {
  const scopes = [];
  const chunks = [];
  const stream = middleware(options, () => (async function* () {
    scopes.push(currentScope());
    yield { type: 'text-delta', text: 'ok' };
  })());
  for await (const chunk of stream) chunks.push(chunk);
  return { chunks, scopes };
}

async function drain(stream) {
  for await (const chunk of stream) void chunk;
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'session-video-capture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('an @absolute local video path becomes a durable attachment without rewriting text', async (t) => {
  const dir = await tempDir(t);
  const data = Buffer.from('original video bytes\u0000\u0001');
  const videoPath = join(dir, 'clip.mp4');
  await writeFile(videoPath, data);
  const attachments = service();
  const middleware = createVideoMiddleware(createCtx({ attachments }));

  const { chunks, scopes } = await run(middleware, request([user(text(`watch @${videoPath} now`))]));

  assert.deepEqual(chunks, [{ type: 'text-delta', text: 'ok' }]);
  const entries = scopes[0].plans[0];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].needle, `@${videoPath}`);
  assert.equal(entries[0].occurrence, 0);
  assert.equal('localRef' in entries[0], false);
  assert.deepEqual(entries[0].ref, refFor(data, 'clip.mp4'));
  assert.equal(attachments.saves.length, 1);
  assert.equal(attachments.saves[0].name, 'clip.mp4');
  assert.deepEqual(attachments.saves[0].data, data);
});

test('a quoted @mention with whitespace and a file:// URI both materialize', async (t) => {
  const dir = await tempDir(t);
  const data = Buffer.from('quoted video bytes');
  const videoPath = join(dir, 'my clip.mkv');
  await writeFile(videoPath, data);
  const attachments = service();
  const middleware = createVideoMiddleware(createCtx({ attachments }));

  const quoted = await run(middleware, request([user(text(`watch @"${videoPath}" now`))]));
  assert.equal(quoted.scopes[0].plans[0][0].needle, `@"${videoPath}"`);
  assert.equal(quoted.scopes[0].plans[0][0].ref.name, 'my clip.mkv');

  const uri = pathToFileURL(videoPath).href;
  const fromUri = await run(middleware, request([user(text(`open ${uri}`))]));
  assert.equal(fromUri.scopes[0].plans[0][0].needle, uri);
  assert.deepEqual(fromUri.scopes[0].plans[0][0].ref, refFor(data, 'my clip.mkv'));
  assert.equal(attachments.saves.length, 2, 'each distinct occurrence target is saved once');
});

test('repeated references dedupe to one durable attachment while keeping occurrences', async (t) => {
  const dir = await tempDir(t);
  const data = Buffer.from('deduped bytes');
  const videoPath = join(dir, 'clip.webm');
  await writeFile(videoPath, data);
  const attachments = service();
  const middleware = createVideoMiddleware(createCtx({ attachments }));
  const uri = pathToFileURL(videoPath).href;

  const { scopes } = await run(middleware, request([
    user(text(`@${videoPath} first, ${uri} second, @${videoPath} third`)),
  ]));

  const entries = scopes[0].plans[0];
  assert.deepEqual(entries.map(({ needle }) => needle), [
    `@${videoPath}`, uri, `@${videoPath}`,
  ]);
  assert.deepEqual(entries.map(({ occurrence }) => occurrence), [0, 0, 1]);
  assert.equal(entries[0].ref.attachmentId, entries[1].ref.attachmentId);
  assert.equal(entries[0].ref.attachmentId, entries[2].ref.attachmentId);
  assert.equal(attachments.saves.length, 1);
});

test('an unreadable referenced video fails explicitly instead of being ignored', async (t) => {
  const dir = await tempDir(t);
  const attachments = service();
  const middleware = createVideoMiddleware(createCtx({ attachments }));
  const missing = join(dir, 'missing.mp4');

  await assert.rejects(drain(middleware(request([user(text(`@${missing}`))]), () => (async function* () {})())), {
    code: 'VIDEO_UNSUPPORTED_INPUT',
  });
  assert.equal(attachments.saves.length, 0);
});

test('a Windows-style reference that cannot be read here fails explicitly', async () => {
  const attachments = service();
  const middleware = createVideoMiddleware(createCtx({ attachments }));
  await assert.rejects(
    drain(middleware(request([user(text('watch @Q:\\nowhere\\clip.mp4'))]), () => (async function* () {})())),
    { code: 'VIDEO_UNSUPPORTED_INPUT' },
  );
  assert.equal(attachments.saves.length, 0);
});

test('an empty referenced video fails explicitly and stores nothing', async (t) => {
  const dir = await tempDir(t);
  const videoPath = join(dir, 'empty.mp4');
  await writeFile(videoPath, Buffer.alloc(0));
  const attachments = service();
  const middleware = createVideoMiddleware(createCtx({ attachments }));

  await assert.rejects(
    drain(middleware(request([user(text(`@${videoPath}`))]), () => (async function* () {})())),
    { code: 'VIDEO_UNSUPPORTED_INPUT' },
  );
  assert.equal(attachments.saves.length, 0);
});

test('a missing attachment store fails explicitly when a local video is referenced', async (t) => {
  const dir = await tempDir(t);
  const videoPath = join(dir, 'clip.mp4');
  await writeFile(videoPath, Buffer.from('bytes'));
  const middleware = createVideoMiddleware(createCtx({ attachments: undefined }));

  assert.throws(
    () => middleware(request([user(text(`@${videoPath}`))]), () => (async function* () {})()),
    { code: 'VIDEO_UNSUPPORTED_INPUT' },
  );
});

test('attachment storage failures surface as the explicit input error', async (t) => {
  const dir = await tempDir(t);
  const videoPath = join(dir, 'clip.mp4');
  await writeFile(videoPath, Buffer.from('bytes'));
  const middleware = createVideoMiddleware(createCtx({ attachments: service({ fail: true }) }));

  await assert.rejects(
    drain(middleware(request([user(text(`@${videoPath}`))]), () => (async function* () {})())),
    { code: 'VIDEO_UNSUPPORTED_INPUT' },
  );
});

test('non-video local references stay ordinary downstream text', async () => {
  const attachments = service();
  const middleware = createVideoMiddleware(createCtx({ attachments }));
  let called = false;
  const downstream = (async function* () {
    called = true;
    yield { type: 'text-delta', text: 'plain' };
  })();
  const result = middleware(request([
    user(text('see @/tmp/notes.txt and file:///tmp/report.pdf and @clip.mp4')),
  ]), () => {
    called = true;
    return downstream;
  });
  assert.equal(called, true);
  assert.equal(result, downstream);
  assert.equal(attachments.saves.length, 0);
});

test('existing file-block and bare-URL capture is preserved', async () => {
  const data = Buffer.from('mp4 bytes');
  const attachment = { ...refFor(data, 'clip.mp4'), attachmentId: refFor(data, 'clip.mp4').attachmentId };
  const mediaTyped = { ...refFor(data, 'clip'), mediaType: 'video/mp4' };
  const attachments = service();
  const middleware = createVideoMiddleware(createCtx({ attachments }));

  const { scopes } = await run(middleware, request([
    user(text('see https://cdn.test/a.mp4 and '), file(attachment), text(' then '), file(mediaTyped)),
  ]));

  const entries = scopes[0].plans[0];
  assert.equal(entries.length, 3);
  assert.equal(entries[0].url, 'https://cdn.test/a.mp4');
  assert.equal(entries[1].ref.name, 'clip.mp4');
  assert.equal(entries[2].ref.name, 'clip');
  assert.equal(attachments.saves.length, 0, 'file blocks are already durable');
});

test('bare URLs and local references keep their text order in one block', async (t) => {
  const dir = await tempDir(t);
  const videoPath = join(dir, 'clip.mp4');
  await writeFile(videoPath, Buffer.from('order bytes'));
  const attachments = service();
  const middleware = createVideoMiddleware(createCtx({ attachments }));
  const uri = pathToFileURL(videoPath).href;

  const first = await run(middleware, request([
    user(text(`https://cdn.test/first.mp4 then @${videoPath}`)),
  ]));
  assert.deepEqual(first.scopes[0].plans[0].map(({ needle }) => needle), [
    'https://cdn.test/first.mp4', `@${videoPath}`,
  ]);

  const second = await run(middleware, request([
    user(text(`@${videoPath} then ${uri}`)),
  ]));
  assert.deepEqual(second.scopes[0].plans[0].map(({ needle }) => needle), [`@${videoPath}`, uri]);
});

test('an aborted request fails before storing the referenced video', async (t) => {
  const dir = await tempDir(t);
  const videoPath = join(dir, 'clip.mp4');
  await writeFile(videoPath, Buffer.from('abort bytes'));
  const attachments = service();
  const middleware = createVideoMiddleware(createCtx({ attachments }));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    drain(middleware(
      request([user(text(`@${videoPath}`))], { signal: controller.signal }),
      () => (async function* () {})(),
    )),
    { code: 'ABORTED' },
  );
  assert.equal(attachments.saves.length, 0);
});

test('expandable video file-block names are captured by extension and media type', async () => {
  const data = Buffer.from('block bytes');
  const attachments = service();
  const middleware = createVideoMiddleware(createCtx({ attachments }));
  const names = ['clip.MOV', 'clip.mkv', 'clip.m2ts', 'clip.avi'];
  const { scopes } = await run(middleware, request([
    user(...names.map((name) => file(refFor(data, name)))),
  ]));
  assert.deepEqual(scopes[0].plans[0].map(({ ref }) => ref.name), names);
  assert.equal(attachments.saves.length, 0);
});
