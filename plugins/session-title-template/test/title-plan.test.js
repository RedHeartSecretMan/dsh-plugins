import assert from 'node:assert/strict';
import { test } from 'node:test';

const { planTitle } = await import('../lib/title-plan.js');
const { resolveConfig } = await import('../lib/config.js');
const { compileTitlePattern } = await import('../lib/title.js');

const config = resolveConfig({});
const date = '1124';
// Mirror the options the provider builds per request, so the spec exercises the
// same shape production uses rather than a hand-rolled subset.
const options = {
  pattern: compileTitlePattern(config.template, config.types.map(type => type.key)),
  date,
  template: config.template,
  types: config.types,
  fallbackType: config.fallbackType,
  cjkSpacing: config.cjkSpacing,
  topicMaxChars: config.topicMaxChars,
};

/** Build the pipeline input for one scenario. */
function context(overrides = {}) {
  return {
    messages: [{ seq: 1, text: '修复登录超时' }],
    current: undefined,
    date,
    options,
    explicitRefresh: false,
    targeted: false,
    hint: undefined,
    ...overrides,
  };
}

test('a session without a provider title is planned for generation', () => {
  const plan = planTitle(context({ current: { title: '修复登录超时', source: { kind: 'fallback' }, messageSeqs: [1] } }));
  assert.equal(plan.refresh, true);
  assert.equal(plan.reason, 'no-provider-title');
});

test('a settled accurate title is kept without asking the model', () => {
  const plan = planTitle(context({
    messages: [{ seq: 1, text: '修复登录超时' }, { seq: 2, text: '谢谢' }],
    current: {
      title: '[1124][修复] 修复登录超时',
      source: { kind: 'provider', model: { provider: 'p', model: 'm' } },
      messageSeqs: [1],
    },
  }));
  assert.equal(plan.refresh, false);
});

test('an explicit refresh always plans generation and carries the hint', () => {
  const plan = planTitle(context({ explicitRefresh: true, hint: 'Explicit refresh' }));
  assert.equal(plan.refresh, true);
  assert.equal(plan.reason, 'explicit');
  assert.equal(plan.hint, 'Explicit refresh');
});

test('a plan carries the fallback title built from the first message', () => {
  const plan = planTitle(context({ messages: [{ seq: 1, text: '帮我把这几张发票整理成报销单，金额和日期都要对上' }] }));
  assert.match(plan.fallback, /^\[1124\]\[探索\] /u);
  assert.ok(plan.fallback.length < 60, 'fallback topic is bounded');
});

test('a plan reports whether the current title must be regenerated', () => {
  const wrongDate = planTitle(context({ current: { title: '[0101][修复] 修复登录超时', source: { kind: 'provider' }, messageSeqs: [1] } }));
  assert.equal(wrongDate.canonical, false);
  assert.equal(wrongDate.refresh, true);
  const rightDate = planTitle(context({ current: { title: '[1124][修复] 修复登录超时', source: { kind: 'provider', model: { provider: 'p', model: 'm' } }, messageSeqs: [1] } }));
  assert.equal(rightDate.canonical, true);
});

test('planning is pure: the same context yields the same plan', () => {
  const input = context({ current: { title: '修复登录超时', source: { kind: 'fallback' }, messageSeqs: [1] } });
  assert.deepEqual(planTitle(input), planTitle(input));
  assert.equal(input.messages.length, 1, 'the input is not mutated');
});
