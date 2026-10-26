// Installed-Harness integration. Only the LLM and durability listener are fixtures.
// ASAR: ELECTRON_RUN_AS_NODE=1 <Electron carrier> --expose-internals scripts/verify-runtime.mjs <runtime root>
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const runtime = process.argv[2];
if (!runtime) throw new Error('Pass the installed DSH runtime root');
const installAnchor = join(resolve(runtime), 'package.json');
const runtimeRequire = createRequire(installAnchor);
const load = pkg => import(pathToFileURL(runtimeRequire.resolve(`@deepseek-ai/${pkg}`)).href);
const [{ Context }, { default: Sessions }, { default: Projections }, { default: Titles }, { default: SystemPrompt }, { default: WorkingDirectory }, { default: Tools }, { loadProfileDirectory, createRuntimeResolution, PluginPackages }] = await Promise.all([
  load('cordis'), load('dsh-session'), load('dsh-session-projection'), load('dsh-session-title'), load('dsh-system-prompt'), load('dsh-working-directory'), load('dsh-tools'), load('dsh-app-boot'),
]);
const home = await mkdtemp(join(tmpdir(), 'session-title-agents-runtime-'));
const previous = Object.fromEntries(['DSH_PROFILE_DIR', 'DSH_HOME', 'DSH_AGENTS_HOME'].map(key => [key, process.env[key]]));
const profileDir = join(home, 'profiles', 'fixture');
process.env.DSH_PROFILE_DIR = profileDir;
process.env.DSH_HOME = join(home, 'harness');
process.env.DSH_AGENTS_HOME = join(home, 'shared');
const cwd = join(home, 'project', 'sub');
const original = join(home, 'original');
const ctx = new Context();
let calls = 0, release, began;
try {
  for (const directory of [process.env.DSH_HOME, process.env.DSH_AGENTS_HOME, join(home, 'project', '.git'), cwd, original, join(profileDir, 'node_modules', '@redheartsecretman')]) await mkdir(directory, { recursive: true });
  const packageName = '@redheartsecretman/session-title-agents';
  const linkedDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const packageLink = join(profileDir, 'node_modules', packageName);
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-fixture', private: true, dependencies: { [packageName]: `link:${linkedDir}` }, dsh: { profile: { bundles: [] } } }));
  await symlink(linkedDir, packageLink, 'dir');
  const profile = loadProfileDirectory('verify-runtime', profileDir, installAnchor);
  const resolution = await createRuntimeResolution({ installAnchor, profile, home });
  await ctx.plugin(PluginPackages, { resolution });
  // This is the real profile resolver. A missing peer in package.json fails this
  // test; no ad hoc registerHooks mapping can hide an undeclared dependency.
  const plugin = await import(pathToFileURL(join(packageLink, 'index.js')).href);
  await writeFile(join(process.env.DSH_HOME, 'AGENTS.md'), '# 会话命名规则\nGlobalNamingMarker。\n# 工程实践\nGLOBAL_ENGINEERING_MUST_NOT_APPEAR');
  await writeFile(join(process.env.DSH_AGENTS_HOME, 'AGENTS.md'), '# Session titles\nSharedNamingMarker.\n# Engineering\nSHARED_ENGINEERING_MUST_NOT_APPEAR');
  await writeFile(join(home, 'project', 'AGENTS.md'), '# Session naming\nProjectNamingMarker.\n## Wording\nUse API nouns.\n# Engineering\nPROJECT_ENGINEERING_MUST_NOT_APPEAR');
  await writeFile(join(cwd, 'AGENTS.local.md'), '# Conversation titles\nLocalNamingMarker.');
  await writeFile(join(original, 'AGENTS.md'), '# Session naming\nWRONG_DIRECTORY_MUST_NOT_APPEAR');
  await ctx.plugin(Sessions); await ctx.plugin(Projections); await ctx.plugin(SystemPrompt, {}); await ctx.plugin(Tools);
  ctx.provide('fs', {});
  await ctx.plugin(WorkingDirectory, { defaultDirectory: original });
  ctx.provide('llm', { async prepareCall(config) { return { config, async *stream(options) {
    calls++;
    for (const marker of ['GlobalNamingMarker', 'SharedNamingMarker', 'ProjectNamingMarker', 'LocalNamingMarker']) assert.ok(options.system.includes(marker), marker);
    assert.ok(options.system.indexOf('GlobalNamingMarker') < options.system.indexOf('ProjectNamingMarker'));
    assert.ok(options.system.indexOf('ProjectNamingMarker') < options.system.indexOf('LocalNamingMarker'));
    assert.ok(!options.system.includes('ENGINEERING_MUST_NOT_APPEAR'));
    assert.ok(!options.system.includes('WRONG_DIRECTORY_MUST_NOT_APPEAR'));
    if (began) { began(); began = undefined; await new Promise(resolve => { release = resolve; }); }
    yield { type: 'text-delta', index: 0, text: '[0101][修复] 排查登录失败' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }; } });
  await ctx.plugin(Titles, { fallbackMaxWords: 8, fallbackMaxBytes: 96, maxTitleBytes: 120 });
  const installed = ctx.plugin(plugin, { provider: 'fixture', model: 'fixture' }); await installed;
  const owner = 'session-title-agents:coordination';
  assert.ok((await ctx.systemPrompt.assemble()).sections.some(section => section.name === owner));
  const session = ctx.sessions.create('contract-fixture', { meta: { createdAt: Date.UTC(2026, 9, 24, 17, 30), cwd: original } });
  const other = ctx.sessions.create('untouched', { meta: { cwd: original } });
  session.append('working-directory/change', { cwd });
  assert.equal(ctx.workingDirectory.get(session), cwd);
  session.append('user/message', { content: [{ type: 'text', text: '修复登录失败' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  const result = await ctx.sessionTitle.refresh(session);
  assert.equal(result.title, '[1025][修复] 排查登录失败'); assert.equal(result.source.provider, plugin.name); assert.equal(calls, 1);
  const auxiliary = session.snapshotEvents().find(event => event.type === 'session/title-llm-request');
  assert.ok(auxiliary); assert.equal(auxiliary.data.titleProvider, plugin.name); assert.equal(auxiliary.data.messages[0].source.kind, plugin.name);
  // Registered through the actual tools service, with real defineTool validation.
  const tool = ctx.tools.get('rename_current_session'); assert.ok(tool);
  const refreshTool = ctx.tools.get('refresh_current_session_title'); assert.ok(refreshTool);
  assert.deepEqual(Object.keys(tool.parameters.properties), ['title']);
  const file = join(home, 'persisted-fixture-events.json');
  ctx.on('session/flush', async value => { if (value === session) await writeFile(file, JSON.stringify(value.snapshotEvents())); });
  const exec = { agent: { session }, signal: new AbortController().signal };
  session.append('user/message', { content: [{ type: 'text', text: '重新概括这个会话' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  await refreshTool.execute({}, exec); assert.equal(calls, 2, 'explicit tool refresh must actually regenerate after a new prompt');
  await assert.rejects(refreshTool.execute({ sessionId: other.id }, exec));
  await assert.rejects(tool.execute({ title: 'bad', sessionId: other.id }, exec));
  await assert.rejects(tool.execute({ title: 'bad' }, { signal: exec.signal }));
  const snapshot = ctx.sessionTitle.get(session);
  const started = new Promise(resolve => { began = resolve; });
  const inFlight = refreshTool.execute({}, exec);
  const rejected = assert.rejects(inFlight);
  await started;
  const renamed = await tool.execute({ title: '[1025][修复] 用户指定标题' }, exec);
  assert.deepEqual(renamed, { title: '[1025][修复] 用户指定标题', persisted: true });
  release(); await rejected;
  assert.equal(ctx.sessionTitle.get(session).source.kind, 'user');
  assert.equal(ctx.sessionTitle.get(session).title, renamed.title);
  assert.equal(ctx.sessionTitle.get(other), undefined);
  const persisted = JSON.parse(await readFile(file, 'utf8')).findLast(event => event.type === 'session/title');
  assert.equal(persisted.data.title, renamed.title); assert.equal(persisted.data.source.kind, 'user');
  session.append('user/message', { content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  assert.equal(ctx.sessionTitle.get(session).title, renamed.title); assert.equal(calls, 3);
  await installed.dispose();
  assert.equal(ctx.tools.get('rename_current_session'), undefined);
  assert.equal(ctx.tools.get('refresh_current_session_title'), undefined);
  assert.ok(!(await ctx.systemPrompt.assemble()).sections.some(section => section.name === owner));
  const recoveryPlugin = ctx.plugin(plugin, { topicMaxChars: 64 }); await recoveryPlugin;
  const recovery = ctx.sessions.create('recovery-fixture', { meta: { createdAt: Date.UTC(2026, 9, 24, 17, 30), cwd: original } });
  recovery.append('working-directory/change', { cwd });
  recovery.append('user/message', { content: [{ type: 'text', text: '调查 Codex 模型降级路由以及上下文窗口和后台审批配置'.repeat(3) }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  const fallback = await ctx.sessionTitle.refresh(recovery);
  assert.ok(Buffer.byteLength(fallback.title) <= 120);
  assert.equal(fallback.source.model, undefined);
  for (let i = 0; i < 5; i++) recovery.append('user/message', { content: [{ type: 'text', text: '继续调查' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  // Only route availability is a fixture here; acceptance/truncation and refresh
  // above and below both go through the real SessionTitleService.
  recovery.requestHeader = () => ({ config: { provider: 'fixture', model: 'fixture' } });
  const beforeRecovery = calls;
  const recovered = await ctx.sessionTitle.refresh(recovery);
  assert.equal(calls, beforeRecovery + 1);
  assert.equal(recovered.title, '[1025][修复] 排查登录失败');
  await recoveryPlugin.dispose();
  assert.ok(snapshot.title);
  console.log('Installed Harness contract: PASS (real profile linked-peer resolution, AGENTS discovery, explicit refresh, tool registration/validation, current-session boundary, pin vs in-flight generation, flush/read-back and unload; LLM and durability listener are fixtures)');
} finally {
  release?.();
  await ctx.fiber.dispose();
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  assert.ok(home.startsWith(join(tmpdir(), 'session-title-agents-runtime-')));
  await rm(home, { recursive: true, force: true });
}
