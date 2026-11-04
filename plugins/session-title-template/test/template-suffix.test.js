import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConfig } from '../lib/config.js';
import { compileTitlePattern, parseModelTitle } from '../lib/title.js';
test('a wrong model date after the topic is replaced rather than copied into the topic', () => {
  const c = resolveConfig({ template: '[{type}] {topic} {date}' });
  const result = parseModelTitle('[修复] 排查登录失败 0101', { ...c, pattern: compileTitlePattern(c.template,c.types.map(t=>t.key)), date:'1025' });
  assert.equal(result.title, '[修复] 排查登录失败 1025');
});
test('adjacent placeholders fail configuration rather than choosing an arbitrary topic boundary', () => {
  assert.throws(() => resolveConfig({ template:'{date}{type}{topic}' }), /separate adjacent/);
});
