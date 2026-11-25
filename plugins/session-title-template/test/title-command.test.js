import assert from 'node:assert/strict';
import { test } from 'node:test';

const { parseTitleCommand, renderTitleStatus, formatTitleFailure } = await import('../lib/title-command.js');

test('a bare verb is recognized', () => {
  assert.deepEqual(parseTitleCommand('status'), { verb: 'status' });
  assert.deepEqual(parseTitleCommand('refresh'), { verb: 'refresh' });
  assert.deepEqual(parseTitleCommand('auto'), { verb: 'auto' });
});

test('the pin verb keeps the rest of the line as the title', () => {
  assert.deepEqual(parseTitleCommand('pin [1124][文档] 我的标题'), { verb: 'pin', title: '[1124][文档] 我的标题' });
});

test('surrounding whitespace is ignored', () => {
  assert.deepEqual(parseTitleCommand('   status   '), { verb: 'status' });
  assert.deepEqual(parseTitleCommand('  pin   修复登录  '), { verb: 'pin', title: '修复登录' });
});

test('an empty line asks for status, so the bare command is useful', () => {
  assert.deepEqual(parseTitleCommand(''), { verb: 'status' });
  assert.deepEqual(parseTitleCommand('   '), { verb: 'status' });
  assert.deepEqual(parseTitleCommand(undefined), { verb: 'status' });
});

test('an unknown verb is rejected with the accepted list', () => {
  const parsed = parseTitleCommand('frobnicate');
  assert.equal(parsed.error, 'unknown-verb');
  assert.match(parsed.message, /status/u);
  assert.match(parsed.message, /refresh/u);
});

test('pin without a title is rejected', () => {
  const parsed = parseTitleCommand('pin');
  assert.equal(parsed.error, 'pin-needs-title');
  assert.match(parsed.message, /pin/u);
});

test('the status text names the built-in rules and the supplements separately', () => {
  const text = renderTitleStatus({
    summary: '内置规则 + 1 个补充来源',
    builtin: { template: '[{date}][{type}] {topic}', dateFormat: 'MMDD', timezone: 'Asia/Shanghai' },
    supplemental: { count: 1, sources: ['~/.dsh/AGENTS.md'] },
    title: { value: '[1124][修复] 修复登录超时', source: 'provider', pinned: false },
    lastFailure: null,
    probe: null,
  });
  assert.match(text, /内置规则 \+ 1 个补充来源/u);
  assert.match(text, /\[\{date\}\]\[\{type\}\] \{topic\}/u);
  assert.match(text, /修复登录超时/u);
  assert.match(text, /~\/\.dsh\/AGENTS\.md/u);
  assert.match(text, /未固定/u);
});

test('a pinned title reads as pinned', () => {
  const text = renderTitleStatus({
    summary: '内置规则',
    builtin: {},
    supplemental: { count: 0, sources: [] },
    title: { value: '[1124][文档] 我的标题', source: 'user', pinned: true },
    lastFailure: null,
    probe: null,
  });
  assert.match(text, /已固定/u);
});

test('a failure is reported by category, never by provider text', () => {
  const text = renderTitleStatus({
    summary: '内置规则',
    builtin: {},
    supplemental: { count: 0, sources: [] },
    title: { value: '[1124][修复] x', source: 'provider', pinned: false },
    lastFailure: { category: 'timeout', route: 'p/m', attempt: 2 },
    probe: null,
  });
  assert.match(text, /timeout/u);
  assert.match(text, /p\/m/u);
});

test('a probe verdict is described in words', () => {
  const unsupported = renderTitleStatus({
    summary: '内置规则', builtin: {}, supplemental: { count: 0, sources: [] },
    title: { value: '', source: 'provider', pinned: false }, lastFailure: null,
    probe: { verdict: 'unsupported' },
  });
  assert.match(unsupported, /丢弃/u);
  const supported = renderTitleStatus({
    summary: '内置规则', builtin: {}, supplemental: { count: 0, sources: [] },
    title: { value: '', source: 'provider', pinned: false }, lastFailure: null,
    probe: { verdict: 'supported' },
  });
  assert.match(supported, /正常/u);
});

test('an empty title is described rather than printed as blank', () => {
  const text = renderTitleStatus({
    summary: '内置规则', builtin: {}, supplemental: { count: 0, sources: [] },
    title: { value: undefined, source: undefined, pinned: false }, lastFailure: null, probe: null,
  });
  assert.match(text, /尚无标题/u);
});

test('every category "describeTitleFailure" can emit has advice', () => {
  // These seven are what lib/run.js actually produces; a missing key would fall
  // back to a generic sentence and lose the actionable part.
  assert.match(formatTitleFailure({ category: 'invalid-title-format' }), /格式/u);
  assert.match(formatTitleFailure({ category: 'input-budget' }), /预算/u);
  assert.match(formatTitleFailure({ category: 'stream-failure' }), /流式|中断/u);
  assert.match(formatTitleFailure({ category: 'tool-output' }), /工具/u);
  assert.match(formatTitleFailure({ category: 'timeout' }), /超时|timeoutMs/u);
  assert.match(formatTitleFailure({ category: 'output-truncated' }), /截断|maxOutputTokens/u);
  assert.match(formatTitleFailure({ category: 'provider-failure' }), /端点|provider/u);
  assert.equal(formatTitleFailure(null), undefined);
});

test('a failure timestamp is rendered in the configured time zone when present', () => {
  const text = renderTitleStatus({
    summary: '内置规则',
    builtin: { timezone: 'Asia/Shanghai' },
    supplemental: { count: 0, sources: [] },
    title: { value: '[1125][探索] 排查构建超时', source: 'fallback', pinned: false },
    lastFailure: { category: 'timeout', route: 'p/m', attempt: 2, at: Date.UTC(2026, 10, 25, 1, 30) },
    probe: null,
  });
  assert.match(text, /时间 11-25 09:30/u);
  assert.match(text, /超时|timeoutMs/u);
});
