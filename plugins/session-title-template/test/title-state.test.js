import assert from 'node:assert/strict';
import { test } from 'node:test';

const { describeTitleState } = await import('../lib/title-state.js');
const { resolveConfig } = await import('../lib/config.js');

const config = resolveConfig({});

/** Build a snapshot request for one session. */
function snapshot(overrides = {}) {
  return {
    config,
    sessionId: 'S1',
    current: {
      title: '[1124][修复] 修复登录超时',
      source: { kind: 'provider', model: { provider: 'p', model: 'm' } },
      messageSeqs: [1],
    },
    guidance: { sources: ['~/.dsh/AGENTS.md'], n: 1 },
    probe: { verdict: 'unsupported' },
    records: [],
    ...overrides,
  };
}

test('the snapshot always reports the built-in rules that always apply', () => {
  const state = describeTitleState(snapshot());
  assert.equal(state.builtin.template, config.template);
  assert.equal(state.builtin.dateFormat, config.dateFormat);
  assert.deepEqual(state.builtin.types, config.types.map(entry => entry.key));
  assert.equal(state.builtin.topicMaxChars, config.topicMaxChars);
  assert.equal(state.builtin.cjkSpacing, config.cjkSpacing);
});

test('supplemental rules are counted separately from the built-in ones', () => {
  const withRules = describeTitleState(snapshot());
  assert.equal(withRules.supplemental.count, 1);
  assert.deepEqual(withRules.supplemental.sources, ['~/.dsh/AGENTS.md']);
  const without = describeTitleState(snapshot({ guidance: undefined }));
  assert.equal(without.supplemental.count, 0);
  assert.deepEqual(without.supplemental.sources, []);
});

test('the summary line names the built-in rules first', () => {
  assert.match(describeTitleState(snapshot()).summary, /^内置规则 \+ 1 个补充来源$/u);
  assert.match(describeTitleState(snapshot({ guidance: undefined })).summary, /^内置规则$/u);
});

test('the current title reports its source and whether it is pinned', () => {
  const provider = describeTitleState(snapshot());
  assert.equal(provider.title.source, 'provider');
  assert.equal(provider.title.pinned, false);
  const user = describeTitleState(snapshot({ current: { title: '[1124][文档] 我的标题', source: { kind: 'user' }, messageSeqs: [1] } }));
  assert.equal(user.title.source, 'user');
  assert.equal(user.title.pinned, true);
  const fallback = describeTitleState(snapshot({ current: { title: '帮我写一篇文章', source: { kind: 'fallback' }, messageSeqs: [1] } }));
  assert.equal(fallback.title.source, 'fallback');
});

test('a recent failure is surfaced with its category, not raw provider text', () => {
  const state = describeTitleState(snapshot({
    records: [{ kind: 'title-call-failed', route: 'p/m', attempt: 1, category: 'timeout', at: 1, sessionId: 'S1' }],
  }));
  assert.equal(state.lastFailure.category, 'timeout');
  assert.equal(state.lastFailure.route, 'p/m');
  assert.equal(state.lastFailure.raw, undefined, 'no provider payload is exposed');
});

test('a failure from another session is not reported as this session failure', () => {
  const state = describeTitleState(snapshot({
    sessionId: 'B',
    records: [
      { kind: 'title-call-failed', category: 'timeout', route: 'p/m', sessionId: 'A', at: 1 },
      { kind: 'title-call-failed', category: 'input-budget', route: 'p/m', sessionId: 'B', at: 2 },
    ],
  }));
  assert.equal(state.lastFailure.category, 'input-budget', 'only this session counts');
});

test('with no failure for this session the snapshot reports none', () => {
  const state = describeTitleState(snapshot({
    sessionId: 'B',
    records: [{ kind: 'title-call-failed', category: 'timeout', route: 'p/m', sessionId: 'A', at: 1 }],
  }));
  assert.equal(state.lastFailure, null);
});

test('the probe verdict is reported when one exists', () => {
  assert.equal(describeTitleState(snapshot()).probe.verdict, 'unsupported');
  assert.equal(describeTitleState(snapshot({ probe: undefined })).probe, null);
});

test('the snapshot degrades to empty sections when nothing is known', () => {
  const state = describeTitleState({ config });
  assert.equal(state.title.value, undefined);
  assert.equal(state.supplemental.count, 0);
  assert.equal(state.lastFailure, null);
  assert.equal(state.probe, null);
});
