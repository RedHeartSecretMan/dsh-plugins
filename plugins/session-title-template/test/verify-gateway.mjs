// Opt-in live title generation against a real OpenAI-compatible gateway.
// Never prints credentials, prompts, full model output or private session data.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as plugin from '../index.js';

if (process.env.RUN_SESSION_TITLE_LIVE !== '1') throw new Error('Set RUN_SESSION_TITLE_LIVE=1 to authorize the live gateway test');
const baseURL = process.env.SESSION_TITLE_GATEWAY ?? 'http://127.0.0.1:3425/v1';
const apiKeyEnv = process.env.SESSION_TITLE_KEY_ENV ?? 'MAGPIE_GATEWAY_KEY';
const modelId = process.env.SESSION_TITLE_MODEL ?? 'auto/deepseek-flash';
if (!process.env[apiKeyEnv]) throw new Error(`${apiKeyEnv} is not set`);
if (!/^[a-z0-9._/-]+$/iu.test(modelId) || modelId.includes('..')) throw new Error('SESSION_TITLE_MODEL is invalid');

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

const load = (name) => import(pathToFileURL(sdk.require.resolve(name)).href);
const [{ Context }, { default: Sessions }, { default: Projections }, { default: TitleService },
  { LlmRuntime }, piAi] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-session-projection'),
  load('@deepseek-ai/dsh-session-title'), load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-llm-pi-ai'),
]);

const home = await mkdtemp(join(tmpdir(), 'session-title-live-'));
process.env.DSH_HOME = home;
process.env.DSH_PROFILE_DIR = join(home, 'profiles', 'live');
process.env.DSH_AGENTS_HOME = join(home, 'agents');
await mkdir(process.env.DSH_PROFILE_DIR, { recursive: true });
await mkdir(process.env.DSH_AGENTS_HOME, { recursive: true });

const ctx = new Context();
const fibers = [];
try {
  fibers.push(ctx.plugin(Sessions));
  fibers.push(ctx.plugin(Projections));
  await Promise.all(fibers);
  ctx.provide('agents', {
    get: () => undefined,
    async resume() { throw new Error('agents fixture does not resume'); },
    turnBoundaryOf: () => ({ lastStepBoundary: { kind: 'start' } }),
  });
  fibers.push(ctx.plugin(TitleService, { fallbackMaxWords: 8, fallbackMaxBytes: 96, maxTitleBytes: 120 }));
  fibers.push(ctx.plugin(LlmRuntime));
  fibers.push(ctx.plugin(piAi.default ?? piAi, {
    providers: {
      magpie: {
        displayName: 'Magpie', apiKeyEnv, api: 'openai-completions', baseURL,
        models: [{ id: modelId, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 8192 }],
      },
    },
  }));
  await Promise.all(fibers.slice(-3));
  for (let i = 0; i < 100 && !ctx.get('sessionTitle'); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(ctx.get('sessionTitle'), 'sessionTitle service did not start');

  // Tools/prompt coordination is covered by verify-runtime.mjs; this probe only
  // needs the real title service, provider registration and real model request.
  const fakeCtx = new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'inject') return async () => undefined;
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await plugin.apply(fakeCtx, {
    provider: 'magpie', model: modelId, maxOutputTokens: 4096, timeoutMs: 120000,
    agentsInstructions: { enabled: false },
  });

  const session = ctx.sessions.create('live-title', { meta: { createdAt: Date.UTC(2026, 10, 5, 4, 0), cwd: home } });
  session.append('user/message', {
    content: [{ type: 'text', text: '修复登录接口在 token 过期时返回 500 的问题，并补上回归测试。' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' });
  const result = await ctx.sessionTitle.refresh(session);
  assert.match(result.title, /^\[\d{4}\]\[(功能|设计|修复|优化|发布|运维|探索|文档|研究)\] .+/u);
  assert.equal(result.source?.provider, plugin.name);
  assert.equal(result.source?.model?.provider, 'magpie');
  console.log(JSON.stringify({ title: result.title, provider: result.source.provider, model: result.source.model }));
} finally {
  for (const fiber of fibers.reverse()) { try { await fiber.dispose?.(); } catch { /* keep tearing down */ } }
}
