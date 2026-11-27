import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'session-title-template-discovery-'));
const previous = Object.fromEntries(['DSH_PROFILE_DIR', 'DSH_HOME', 'DSH_AGENTS_HOME'].map(key => [key, process.env[key]]));
after(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(scratch, { recursive: true, force: true });
});

const { createInstructionReader, discoverInstructionFilesLocally } = await import('../lib/instructions.js');

const NAMING = '## 会话标题命名\n\n标题格式为 `[MMDD][类型] 主题`。\n';
const ENGINEERING = '## 工程实践原则\n\n这一节不该进入提示词。\n';

/** Build one repository tree plus shared global instruction homes. */
async function tree() {
  const root = await mkdtemp(join(scratch, 'repo-'));
  const shared = await mkdtemp(join(scratch, 'shared-'));
  const harness = await mkdtemp(join(scratch, 'harness-'));
  await mkdir(join(root, '.git'));
  await mkdir(join(root, 'pkg', 'deep'), { recursive: true });
  await writeFile(join(shared, 'AGENTS.md'), `${NAMING}${ENGINEERING}`);
  await writeFile(join(harness, 'AGENTS.md'), '## 会话命名偏好\n\n主题尽量具体。\n');
  await writeFile(join(root, 'AGENTS.md'), `${NAMING}${ENGINEERING}`);
  await writeFile(join(root, 'pkg', 'AGENTS.md'), '## 会话标题规则\n\n包内标题带上模块名。\n');
  // 个人覆盖文件不在范围内：写出来是为了断言它不会被读。
  await writeFile(join(root, 'pkg', 'AGENTS.local.md'), '## 对话命名覆盖\n\n只在本机生效。\n');
  return { root, shared, harness, cwd: join(root, 'pkg', 'deep') };
}

test('discovery walks global homes then the repository root down to the working directory', async () => {
  const { root, shared, harness, cwd } = await tree();
  process.env.DSH_AGENTS_HOME = shared;
  process.env.DSH_HOME = harness;

  const records = await discoverInstructionFilesLocally({ cwd });
  const paths = records.map(record => record.absolutePath);
  assert.deepEqual(paths, [
    join(harness, 'AGENTS.md'),
    join(shared, 'AGENTS.md'),
    join(root, 'AGENTS.md'),
    join(root, 'pkg', 'AGENTS.md'),
  ]);
});

test('a duplicated shared file is discovered once', async () => {
  const { shared, harness, cwd } = await tree();
  await rm(join(shared, 'AGENTS.md'));
  await symlink(join(harness, 'AGENTS.md'), join(shared, 'AGENTS.md'));
  process.env.DSH_AGENTS_HOME = shared;
  process.env.DSH_HOME = harness;

  const { realpath } = await import('node:fs/promises');
  const records = await discoverInstructionFilesLocally({ cwd });
  const harnessFile = await realpath(join(harness, 'AGENTS.md'));
  const resolved = await Promise.all(records.map(async record => {
    try { return await realpath(record.absolutePath); } catch { return record.absolutePath; }
  }));
  assert.equal(resolved.filter(path => path === harnessFile).length, 1);
});

test('an unreadable candidate is skipped instead of aborting discovery', async () => {
  const { root, shared, harness, cwd } = await tree();
  // 指向不存在的目标：Linux 上是 ENOENT，Windows 上是平台错误码（无法遵循链接）。
  await rm(join(shared, 'AGENTS.md'));
  await symlink(join(root, 'missing-target.md'), join(shared, 'AGENTS.md'));
  process.env.DSH_AGENTS_HOME = shared;
  process.env.DSH_HOME = harness;

  const records = await discoverInstructionFilesLocally({ cwd, onDiagnostic: () => {} });
  const paths = records.map(record => record.absolutePath);
  // 坏候选只跳过自己：其余可读来源仍必须被解析出来。
  assert.ok(paths.includes(join(harness, 'AGENTS.md')));
  assert.ok(paths.includes(join(root, 'AGENTS.md')));
  assert.ok(!paths.includes(join(shared, 'AGENTS.md')));
});

test('a working directory outside a repository only reads itself', async () => {
  const loose = await mkdtemp(join(scratch, 'loose-'));
  await writeFile(join(loose, 'AGENTS.md'), `${NAMING}`);
  process.env.DSH_AGENTS_HOME = join(scratch, 'absent-shared');
  process.env.DSH_HOME = join(scratch, 'absent-harness');

  const records = await discoverInstructionFilesLocally({ cwd: loose });
  assert.deepEqual(records.map(record => record.absolutePath), [join(loose, 'AGENTS.md')]);
});

test('the reader keeps only naming sections and orders them broad to specific', async () => {
  const { root, shared, harness, cwd } = await tree();
  process.env.DSH_AGENTS_HOME = shared;
  process.env.DSH_HOME = harness;

  const reasons = [];
  const read = createInstructionReader({
    discover: options => discoverInstructionFilesLocally(options),
    onDiagnostic: reason => reasons.push(reason),
  });
  const result = await read({ cwd, maxBytes: 4096 });

  assert.equal(result.unavailable, undefined);
  assert.doesNotMatch(result.text, /工程实践原则/u);
  assert.match(result.text, /标题格式为/u);
  assert.match(result.text, /主题尽量具体/u);
  assert.match(result.text, /包内标题带上模块名/u);
  assert.doesNotMatch(result.text, /只在本机生效/u);
  const order = ['主题尽量具体', '标题格式为', '包内标题带上模块名']
    .map(marker => result.text.indexOf(marker));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.deepEqual(reasons, []);
});

test('the default reader finds naming rules without any extra dependency', async () => {
  const { shared, harness, cwd } = await tree();
  process.env.DSH_AGENTS_HOME = shared;
  process.env.DSH_HOME = harness;
  const reasons = [];

  // No injected discover: this exercises the production path without a runtime SDK dependency.
  const result = await createInstructionReader({ onDiagnostic: reason => reasons.push(reason) })({ cwd, maxBytes: 4096 });

  assert.ok(result.text.includes('标题格式为'), 'naming guidance should reach the prompt');
  assert.deepEqual(reasons, []);
});

test('discovery honours cancellation', async () => {
  const { cwd } = await tree();
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(discoverInstructionFilesLocally({ cwd, signal: controller.signal }), /cancelled|aborted/iu);
});
