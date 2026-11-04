// Opt-in live test against a real OpenAI-compatible gateway.
// Never prints credentials, attachment data, or private model output.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as plugin from '../index.js';

if (process.env.RUN_SESSION_VIDEO_LIVE !== '1') throw new Error('Set RUN_SESSION_VIDEO_LIVE=1 to authorize the gateway test');

const baseURL = process.env.SESSION_VIDEO_GATEWAY ?? 'http://127.0.0.1:3425/v1';
const apiKeyEnv = process.env.SESSION_VIDEO_KEY_ENV ?? 'MAGPIE_GATEWAY_KEY';
const modelId = process.env.SESSION_VIDEO_MODEL ?? 'auto/deepseek-flash';
const fixture = process.env.SESSION_VIDEO_FIXTURE;
if (!fixture) throw new Error('Set SESSION_VIDEO_FIXTURE to an MP4 clip before running the live gateway test');
if (!process.env[apiKeyEnv]) throw new Error(`${apiKeyEnv} is not set`);

const roots = [
  process.resourcesPath && join(process.resourcesPath, 'app.asar', 'dsh'),
  ...process.argv.filter((arg) => /app\.asar[/\\]dsh$/.test(arg)),
  join(dirname(dirname(process.execPath)), 'Resources', 'app.asar', 'dsh'),
].filter(Boolean);
let sdk;
for (const root of roots) {
  try {
    const require = createRequire(pathToFileURL(join(root, 'package.json')));
    sdk = { root, require };
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

const home = await mkdtemp(join(tmpdir(), 'session-video-live-'));
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
        apiKeyEnv,
        api: 'openai-completions',
        baseURL,
        models: [{ id: modelId, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 8192, reasoningEfforts: { low: 'low', high: 'high', max: 'max' } }],
      },
    },
  }));
  fibers.push(ctx.plugin(plugin, { enabled: true, videoRoutes: [`magpie/${modelId}`], storyboard: { enabled: false } }));
  await Promise.all(fibers.slice(-2));

  const attachments = ctx.get('attachments');
  const ref = await attachments.saveFile({ data: await readFile(fixture), name: 'original.mp4' });
  const send = async (content, tools) => {
    const signal = AbortSignal.timeout(120000);
    const prepared = await ctx.llm.prepareCall({ provider: 'magpie', model: modelId, maxTokens: 4096, reasoningEffort: 'low' }, signal);
    const chunks = [];
    for await (const chunk of prepared.stream({
      ...prepared.config,
      messages: [{ id: randomUUID(), role: 'user', source: { kind: 'user' }, content }],
      system: 'Describe only the supplied media. Use the requested tool when given.',
      tools,
      signal,
    })) chunks.push(chunk);
    const finish = chunks.findLast((chunk) => chunk.type === 'finish');
    if (!finish || finish.reason?.kind === 'error' || finish.reason?.kind === 'aborted') throw new Error(JSON.stringify(finish));
    return chunks;
  };

  const tool = { name: 'record_observation', description: 'Record the video observation.', parameters: { type: 'object', properties: { color: { type: 'string' }, action: { type: 'string' } }, required: ['color', 'action'], additionalProperties: false } };
  const fileResult = await send([
    { type: 'text', text: '请调用 record_observation 工具，记录视频主体的颜色与动作。' },
    { type: 'file', attachment: ref },
  ], [tool]);
  const call = fileResult.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call');
  assert.equal(call?.block?.name, 'record_observation', 'live backend must accept video and return the requested tool call');
  console.log('PASS live gateway: original video attachment produced a video tool call');

  const urlResult = await send([{ type: 'text', text: '请用一句中文描述视频的画面和变化。 https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4' }]);
  const text = urlResult.filter((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'text').map((chunk) => chunk.block.text).join('');
  assert.ok(text.trim().length > 0, 'live backend must answer a video URL');
  console.log('PASS live gateway: a bare video URL is answered, not downloaded or framed');
} finally {
  for (const fiber of fibers.reverse()) {
    try { await fiber.dispose?.(); } catch { /* keep tearing down */ }
  }
}
