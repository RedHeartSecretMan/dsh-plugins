import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULTS, resolveConfig } from '../lib/config.js';
import { formatConfigYaml, parseConfigYaml } from '../lib/yaml.js';

test('round-trips full plugin config including types, routes, retitle, and special strings', () => {
  const sample = {
    template: '[{date}][{type}] {topic}',
    dateFormat: 'YYYY-MM-DD',
    timezone: 'Asia/Shanghai',
    language: 'zh',
    cjkSpacing: true,
    topicMinChars: 8,
    topicMaxChars: 24,
    fallbackType: '探索',
    types: [
      { key: '功能', hint: '新增能力、开发新功能' },
      { key: '修复', hint: "Fix bugs: don't break \"quotes\" #1" },
      { key: '探索', hint: '理解现状', provisional: true },
    ],
    provider: 'deepseek',
    model: 'deepseek-chat',
    maxInputBytes: 8192,
    maxOutputTokens: 2048,
    timeoutMs: 45000,
    retryAttempts: 3,
    retryDelayMs: 500,
    maxProvisionalRefinements: 4,
    roleProbe: { enabled: false },
    agentsInstructions: { enabled: true, maxBytes: 4096 },
    backfill: {
      enabled: true,
      retitle: [
        { id: 'session-1', hint: 'Keep API nouns: OAuth & SAML' },
        { id: 'session-2', hint: '' },
      ],
    },
    fallbackRoute: { provider: 'openai', model: 'gpt-4.1-mini' },
  };
  const yaml = formatConfigYaml(sample);
  assert.ok(yaml.includes("template: '[{date}][{type}] {topic}'"), yaml);
  assert.ok(yaml.includes('- key: 探索\n    hint: 理解现状\n    provisional: true'), yaml);
  const parsed = parseConfigYaml(yaml);
  assert.deepEqual(parsed, sample);
  assert.doesNotThrow(() => resolveConfig(parsed));
});

test('parses cordis.patch.yml config block cleanly', async () => {
  const rawPatch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const parsed = parseConfigYaml(rawPatch);
  assert.ok(Array.isArray(parsed));
  const insertBlock = parsed.find(item => Array.isArray(item.insert));
  assert.ok(insertBlock);
  const cfg = insertBlock.insert[0].config;
  assert.equal(cfg.template, '[{date}][{type}] {topic}');
  assert.equal(cfg.timezone, 'Asia/Shanghai');
  assert.equal(cfg.agentsInstructions.maxBytes, 4096);
  assert.equal(cfg.backfill.enabled, false);
  assert.doesNotThrow(() => resolveConfig(cfg));
});

test('supports comments, indentless sequences, flow collections, block scalars, and doc markers', () => {
  const doc = [
    '---',
    '# Leading comment',
    'language: en # inline comment',
    'cjkSpacing: false',
    'types:',
    '- key: feat',
    '  hint: |-',
    '    Build new features',
    '    or capabilities',
    '- { key: fix, hint: "Resolve bugs, crashes: fast", provisional: true }',
    'fallbackType: fix',
    'backfill:',
    '  enabled: true',
    '  retitle: [',
    '    { id: s1, hint: "Re-scope" },',
    '  ]',
    '...',
  ].join('\n');
  const parsed = parseConfigYaml(doc);
  assert.equal(parsed.language, 'en');
  assert.equal(parsed.cjkSpacing, false);
  assert.deepEqual(parsed.types, [
    { key: 'feat', hint: 'Build new features\nor capabilities' },
    { key: 'fix', hint: 'Resolve bugs, crashes: fast', provisional: true },
  ]);
  assert.deepEqual(parsed.backfill, {
    enabled: true,
    retitle: [{ id: 's1', hint: 'Re-scope' }],
  });
});

test('handles empty documents, null values, folded block scalars, and edge scalars', () => {
  assert.deepEqual(parseConfigYaml(''), {});
  assert.deepEqual(parseConfigYaml('# only comments\n  # indented comment\n'), {});
  assert.deepEqual(parseConfigYaml('a: null\nb: ~\nc:\nd: []\ne: {}\n'), {
    a: null, b: null, c: null, d: [], e: {},
  });
  const folded = parseConfigYaml('note: >-\n  hello\n  world\n\n  next\n');
  assert.equal(folded.note, 'hello world\nnext');

  // Reserved-looking strings survive formatting without turning into booleans/numbers.
  const tricky = { a: 'true', b: '42', c: 'null', d: 'yes', e: ' leads', f: 'a: b', g: 'x # y', h: '' };
  assert.deepEqual(parseConfigYaml(formatConfigYaml(tricky)), tricky);
});

test('formatConfigYaml omits undefined properties cleanly', () => {
  const yaml = formatConfigYaml({ ...DEFAULTS });
  assert.doesNotMatch(yaml, /provider:/u);
  assert.doesNotMatch(yaml, /model:/u);
  const parsed = parseConfigYaml(yaml);
  assert.doesNotThrow(() => resolveConfig(parsed));
});

test('rejects invalid YAML syntax and unsupported features with invalid-yaml code and line numbers', () => {
  const reject = (input, pattern) => assert.throws(
    () => parseConfigYaml(input),
    error => error.code === 'invalid-yaml' && pattern.test(error.message),
  );
  reject('\tlanguage: zh\n', /line 1.*tabs/iu);
  reject('language: "unterminated\n', /line 1.*unterminated/iu);
  reject("template: 'unterminated\n", /line 1.*unterminated/iu);
  reject('language: zh\nlanguage: en\n', /line 2.*duplicate key/iu);
  reject('a: &anchor foo\nb: *anchor\n', /anchors, aliases, and tags/iu);
  reject('a: !custom foo\n', /anchors, aliases, and tags/iu);
  reject('<<: { a: 1 }\n', /merge key/iu);
  reject('a: 1\n---\nb: 2\n', /multiple YAML documents/iu);
  reject('a: [1, 2\n', /unterminated flow/iu);
  reject('a: 1\n  b: 2\n', /line 2.*indentation/iu);
});
