import assert from 'node:assert/strict';
import { test } from 'node:test';

const { planTitle } = await import('../lib/title-plan.js');
const { resolveConfig } = await import('../lib/config.js');
const { compileTitlePattern, isFormattedTitle } = await import('../lib/title.js');
const require_isFormatted = { isFormattedTitle };

const config = resolveConfig({});
const options = {
  pattern: compileTitlePattern(config.template, config.types.map(type => type.key)),
  date: '1124',
  template: config.template,
  types: config.types,
  fallbackType: config.fallbackType,
  cjkSpacing: config.cjkSpacing,
  topicMaxChars: config.topicMaxChars,
};

/** Build a planning context for one subagent delegation. */
function delegated(overrides = {}) {
  return {
    messages: [{ seq: 1, text: '你是一篇中文行业分析报告的分章写手。第一步……第二步……第三步……' }],
    current: undefined,
    options,
    delegationLabel: '起草第 3—4 章',
    isSubagent: true,
    ...overrides,
  };
}

test('a subagent is titled from its delegation label instead of its task brief', () => {
  const plan = planTitle(delegated());
  assert.equal(plan.refresh, true);
  assert.equal(plan.source, 'delegation-label');
});

test('the delegation label produces a formatted title without a model call', () => {
  const plan = planTitle(delegated());
  assert.match(plan.delegationTitle, /^\[1124\]\[[^\]]+\] 起草第 3—4 章$/u);
});

test('a root session never uses the delegation label source', () => {
  const plan = planTitle(delegated({ isSubagent: false }));
  assert.notEqual(plan.source, 'delegation-label');
});

test('a missing delegation label falls back to the message source', () => {
  const plan = planTitle(delegated({ delegationLabel: undefined }));
  assert.notEqual(plan.source, 'delegation-label');
  assert.match(plan.fallback, /^\[1124\]\[探索\] /u);
});

test('an existing provider title is kept even for a subagent', () => {
  const plan = planTitle(delegated({
    current: {
      title: '[1124][文档] 起草推理经济学章节',
      source: { kind: 'provider', model: { provider: 'p', model: 'm' } },
      messageSeqs: [1],
    },
    messages: [{ seq: 1, text: '继续' }],
  }));
  assert.equal(plan.refresh, false);
});

test('a label with trailing punctuation still produces a canonical title', () => {
  const plan = planTitle(delegated({ delegationLabel: '修复登录：超时重试。' }));
  const { isFormattedTitle } = require_isFormatted;
  assert.equal(isFormattedTitle(plan.delegationTitle, options), true, `not canonical: ${plan.delegationTitle}`);
});

test('a label mixing CJK and Latin gets the configured spacing', () => {
  const plan = planTitle(delegated({ delegationLabel: 'review vLLM 的 KV cache 实现' }));
  assert.match(plan.delegationTitle, /review vLLM 的 KV cache 实现$/u);
});

test('a label longer than the topic budget is truncated instead of cut mid-word', () => {
  const plan = planTitle(delegated({ delegationLabel: '起草推理经济学报告的第三章与第四章全部技术细节部分' }));
  assert.ok(plan.delegationTitle !== undefined);
  const topic = plan.delegationTitle.replace(/^\[[^\]]+\]\[[^\]]+\] /u, '');
  assert.ok(topic.length <= config.topicMaxChars, `topic ${topic} stays within ${config.topicMaxChars}`);
});
