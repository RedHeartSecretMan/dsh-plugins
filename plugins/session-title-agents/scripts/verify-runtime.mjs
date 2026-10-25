// Optional contract check against the user's installed Harness, not a mock title service.
// Run with an Electron Node carrier (ELECTRON_RUN_AS_NODE=1) when runtime is in ASAR:
// <carrier> --expose-internals scripts/verify-runtime.mjs <absolute runtime root>
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const runtime = process.argv[2];
if (!runtime) throw new Error('Pass the installed DSH runtime root as the first argument');
const load = pkg => import(pathToFileURL(join(resolve(runtime), 'node_modules', '@deepseek-ai', pkg, 'lib', 'index.js')).href);
const [{ Context }, { default: Sessions }, { default: Projections }, { default: Titles }, plugin] = await Promise.all([
  load('cordis'), load('dsh-session'), load('dsh-session-projection'), load('dsh-session-title'), import('../index.js'),
]);
const home = await mkdtemp(join(tmpdir(), 'session-title-agents-runtime-'));
const previous = process.env.DSH_PROFILE_DIR; process.env.DSH_PROFILE_DIR = home;
const ctx = new Context();
let calls = 0;
try {
  await ctx.plugin(Sessions);
  await ctx.plugin(Projections);
  ctx.provide('llm', {
    async prepareCall(config) {
      return { config, async *stream() { calls++; yield { type: 'text-delta', index: 0, text: '[0101][修复] 排查登录失败' }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
    },
  });
  await ctx.plugin(Titles, { fallbackMaxWords: 8, fallbackMaxBytes: 96, maxTitleBytes: 120 });
  const installed = ctx.plugin(plugin, { provider: 'fixture', model: 'fixture' });
  await installed;
  const session = ctx.sessions.create('contract-fixture', { meta: { createdAt: Date.UTC(2026, 9, 24, 17, 30) } });
  session.append('user/message', { content: [{ type: 'text', text: '修复登录失败' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  const result = await ctx.sessionTitle.refresh(session);
  assert.equal(result.title, '[1025][修复] 排查登录失败');
  assert.equal(result.source.provider, plugin.name);
  assert.equal(calls, 1);
  const auxiliary = session.snapshotEvents().find(event => event.type === 'session/title-llm-request');
  assert.ok(auxiliary);
  assert.equal(auxiliary.data.titleProvider, plugin.name);
  assert.equal(auxiliary.data.messages[0].source.kind, plugin.name);
  const unchanged = await ctx.sessionTitle.refresh(session);
  assert.equal(unchanged.title, result.title); assert.equal(calls, 1);
  ctx.sessionTitle.rename(session, 'manual title');
  session.append('user/message', { content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  assert.equal(ctx.sessionTitle.get(session).title, 'manual title');
  assert.equal(calls, 1);
  await installed.dispose();
  console.log('Installed Harness contract: PASS (real SessionStore, projections, title service, disposal; LLM adapter stubbed)');
} finally {
  await ctx.fiber.dispose();
  if (previous === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = previous;
  await rm(home, { recursive: true, force: true });
}
