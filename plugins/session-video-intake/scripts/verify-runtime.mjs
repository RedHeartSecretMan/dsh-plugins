import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as plugin from '../index.js';

// Load the SDK that the running desktop app ships, not a separately installed one.
const roots = [
  process.resourcesPath && join(process.resourcesPath, 'app.asar', 'dsh'),
  ...process.argv.filter((arg) => /app\.asar[/\\]dsh$/.test(arg)),
  join(dirname(dirname(process.execPath)), 'Resources', 'app.asar', 'dsh'),
].filter(Boolean);
let sdk;
for (const root of roots) {
  try {
    const require = createRequire(pathToFileURL(join(root, 'package.json')));
    const metadata = require('@deepseek-ai/dsh-llm-pi-ai/package.json');
    sdk = { root, require, version: metadata.version };
    break;
  } catch {
    // Try the next candidate root.
  }
}
assert.ok(sdk, 'no installed DeepSeek Harness SDK was found');

const get = (name) => import(pathToFileURL(sdk.require.resolve(name)).href);
const [{ Context }, { LlmRuntime }, LocalAttachmentStore, piAi] = await Promise.all([
  get('@deepseek-ai/cordis'),
  get('@deepseek-ai/dsh-llm'),
  get('@deepseek-ai/dsh-attachment-local'),
  get('@deepseek-ai/dsh-llm-pi-ai'),
]);

const fixtureRoot = process.env.VIDEO_FIXTURE_ROOT;
if (!fixtureRoot) throw new Error('Set VIDEO_FIXTURE_ROOT to a directory containing remote/flower.mp4 and remote/cat.jpg');
const videoBytes = await readFile(join(fixtureRoot, 'remote/flower.mp4'));
const imageBytes = await readFile(join(fixtureRoot, 'remote/cat.jpg'));
const ffmpegPath = process.env.SESSION_VIDEO_FFMPEG ?? '/opt/homebrew/bin/ffmpeg';
const ffprobePath = process.env.SESSION_VIDEO_FFPROBE ?? '/opt/homebrew/bin/ffprobe';
const hasFfmpeg = existsSync(ffmpegPath) && existsSync(ffprobePath);

const captured = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks));
  captured.push(payload);
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const event = (delta, finish = null) => response.write(`data: ${JSON.stringify({
    id: 'session-video-request', object: 'chat.completion.chunk', created: 1, model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`);
  event({ role: 'assistant' });
  event({ content: 'Received. ' });
  if (payload.tools?.length) {
    event({ tool_calls: [{ index: 0, id: 'call_video', type: 'function', function: { name: 'record_observation', arguments: '{"color":' } }] });
    event({ tool_calls: [{ index: 0, function: { arguments: '"red"}' } }] });
    event({}, 'tool_calls');
  } else event({}, 'stop');
  response.write(`data: ${JSON.stringify({ id: 'session-video-request', choices: [], usage: { prompt_tokens: 55, completion_tokens: 8, total_tokens: 63 } })}\n\n`);
  response.end('data: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
process.env.SESSION_VIDEO_TEST_KEY = 'local-test-only';

const home = await mkdtemp(join(tmpdir(), 'session-video-intake-'));
const ctx = new Context();
const fibers = [];
try {
  fibers.push(ctx.plugin(LlmRuntime));
  fibers.push(ctx.plugin(LocalAttachmentStore.default ?? LocalAttachmentStore, { dshHome: home }));
  await Promise.all(fibers);
  fibers.push(ctx.plugin(piAi.default ?? piAi, {
    providers: {
      magpie: {
        displayName: 'Magpie',
        apiKeyEnv: 'SESSION_VIDEO_TEST_KEY',
        api: 'openai-completions',
        baseURL,
        models: [
          { id: 'mock-model', input: ['text', 'image'], contextWindow: 100000, maxTokens: 8192 },
          { id: 'image-model', input: ['text', 'image'], contextWindow: 100000, maxTokens: 8192 },
          { id: 'text-model', input: ['text'], contextWindow: 100000, maxTokens: 8192 },
        ],
      },
    },
  }));
  fibers.push(ctx.plugin(plugin, {
    enabled: true,
    videoRoutes: ['magpie/mock-model'],
    storyboard: { enabled: hasFfmpeg, ffmpegPath, ffprobePath },
  }));
  await Promise.all(fibers.slice(-2));

  assert.deepEqual(ctx.llm.listProviders().map((entry) => entry.id), ['magpie'], 'the plugin must not register a second provider');

  const attachments = ctx.get('attachments');
  const ref = await attachments.saveFile({ data: videoBytes, name: 'original.mp4' });
  const image = await attachments.saveImage({ data: imageBytes, mediaType: 'image/jpeg', name: 'cat.jpg' });
  const makeMessage = (content) => Object.freeze({
    id: randomUUID(), role: 'user', source: Object.freeze({ kind: 'user' }),
    content: Object.freeze(content.map((block) => Object.freeze(block))),
  });
  async function run(model, messages, tools) {
    const signal = AbortSignal.timeout(60000);
    const prepared = await ctx.llm.prepareCall({ provider: 'magpie', model, maxTokens: 1024 }, signal);
    const options = Object.freeze({ ...prepared.config, system: 'Describe the supplied media.', messages: Object.freeze(messages), tools, signal });
    const chunks = [];
    for await (const chunk of prepared.stream(options)) chunks.push(chunk);
    return { chunks, finish: chunks.findLast((chunk) => chunk.type === 'finish') };
  }
  const tools = [{ name: 'record_observation', description: 'Record the flower color.', parameters: { type: 'object', properties: { color: { type: 'string' } }, required: ['color'] } }];

  // 1. Native video route keeps video_url and the original bytes.
  const nativeMessage = makeMessage([
    { type: 'text', text: 'Observe this original video, image, and then use the tool.' },
    { type: 'image', attachment: image },
    { type: 'file', attachment: ref },
  ]);
  const native = await run('mock-model', [nativeMessage], tools);
  assert.notEqual(native.finish?.reason?.kind, 'error', JSON.stringify(native.finish));
  const nativeContent = captured[0].messages.filter((message) => message.role === 'user').flatMap((message) => message.content);
  const videoPart = nativeContent.find((entry) => entry.type === 'video_url');
  assert.ok(videoPart?.video_url.url.startsWith('data:video/mp4;base64,'));
  assert.deepEqual(Buffer.from(videoPart.video_url.url.split(',')[1], 'base64'), videoBytes);
  assert.equal(nativeContent.filter((entry) => entry.type === 'image_url').length, 1);
  assert.ok(native.chunks.some((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call'));
  console.log('PASS installed SDK: native route sends video_url with the exact original bytes');

  // 2. Image-only route gets a storyboard: manifest text plus image parts, no video_url.
  if (!hasFfmpeg) {
    console.log('SKIP installed SDK: storyboard fallback (ffmpeg not found)');
  } else {
    const imageOnly = await run('image-model', [makeMessage([
      { type: 'text', text: 'Describe this video.' },
      { type: 'file', attachment: ref },
    ])]);
    assert.notEqual(imageOnly.finish?.reason?.kind, 'error', JSON.stringify(imageOnly.finish));
    const body = captured[1];
    const content = body.messages.filter((message) => message.role === 'user').flatMap((message) => message.content);
    assert.equal(content.some((entry) => entry.type === 'video_url'), false, 'image-only route must not receive video_url');
    const imageParts = content.filter((entry) => entry.type === 'image_url');
    assert.ok(imageParts.length >= 1, 'storyboard image expected');
    assert.match(imageParts[0].image_url.url, /^data:image\/png;base64,/);
    const manifest = content.filter((entry) => typeof entry.text === 'string' && entry.text.includes('分镜')).map((entry) => entry.text).join('');
    assert.ok(manifest.length > 0, 'storyboard manifest expected');
    console.log('PASS installed SDK: image-only route receives a storyboard image plus manifest');
  }

  // 3. A text-only route cannot accept video and fails explicitly.
  const unsupported = await run('text-model', [makeMessage([{ type: 'file', attachment: ref }])]);
  assert.equal(unsupported.finish?.reason?.kind, 'error', 'text-only route must fail');
  console.log('PASS installed SDK: a route with no media capability fails instead of sending a file path');

  // 4. Text-only requests stay untouched.
  await run('mock-model', [makeMessage([{ type: 'text', text: 'Text only.' }])], tools);
  const textBody = captured.at(-1);
  assert.equal(textBody.messages.some((message) => Array.isArray(message.content) && message.content.some((entry) => entry.type === 'video_url')), false);
  console.log('PASS installed SDK: text-only requests keep their normal shape');
  console.log(JSON.stringify({ sdk: sdk.version, originalVideoBytes: videoBytes.length, requests: captured.length }));
} finally {
  for (const fiber of fibers.reverse()) {
    try { await fiber.dispose?.(); } catch { /* keep tearing down */ }
  }
  await new Promise((resolve) => server.close(resolve));
}
