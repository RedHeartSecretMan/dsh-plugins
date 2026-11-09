import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUDIT_MESSAGE_COUNT,
  AUDIT_TEXT_BYTES,
  decideTitleRefresh,
  hasTopicShift,
  isAcknowledgement,
  isSubstantive,
  lexicalOverlap,
  shouldRefreshTitle,
} from '../lib/refresh-policy.js';

const title = '[1025][修复] 排查登录超时';
const provider = (overrides = {}) => ({
  title,
  messageSeqs: [1],
  source: { kind: 'provider', model: { provider: 'prior', model: 'prior-model' } },
  ...overrides,
});
const message = (seq, text) => ({ seq, text });
const settled = (overrides = {}) => ({
  current: provider(), canonical: true, provisional: false, ...overrides,
});

describe('message classification', () => {
  it('treats short acknowledgements, confirmations, and continuation requests as non-substantive', () => {
    for (const text of ['谢谢', '好的', '继续', 'ok', 'thanks', '收到', '可以', '嗯嗯', 'ok, thanks', '继续，不要变更标题']) {
      assert.equal(isAcknowledgement(text), true, text);
      assert.equal(isSubstantive(text), false, text);
    }
    assert.equal(isAcknowledgement('分析插件是否应该扫描重命名标题这几个字'), false);
  });

  it('requires real content before a message counts as substantive', () => {
    assert.equal(isSubstantive('帮我看看'), false);
    assert.equal(isSubstantive('帮我看看支付回调失败的具体原因和复现步骤'), true);
    assert.equal(isSubstantive('补充一下测试账号以及完整的复现步骤和日志信息'), true);
  });

  it('detects topic-shift markers in both languages without treating mere title talk as a shift', () => {
    for (const text of [
      '另外，帮我设计一个新的缓存层方案',
      '改成排查渲染性能问题',
      '重新整理这份部署文档',
      '现在做支付回调的对账任务',
      'new task: add a retry budget',
      'instead let us review the caching layer',
      'switch to the deployment pipeline',
    ]) {
      assert.equal(hasTopicShift(text), true, text);
    }
    assert.equal(hasTopicShift('分析插件是否应该扫描重命名标题这几个字'), false);
    assert.equal(hasTopicShift('继续排查登录超时'), false);
  });

  it('measures token continuity for the overlap heuristic', () => {
    assert.equal(lexicalOverlap('排查登录超时的日志', [title]) > 0.2, true);
    assert.equal(lexicalOverlap('设计新的缓存层方案', [title]) < 0.2, true);
    assert.equal(lexicalOverlap('', [title]), 1);
  });
});

describe('decideTitleRefresh', () => {
  it('skips a settled title for short acknowledgement messages', () => {
    const decision = decideTitleRefresh({ ...settled(), messages: [message(1, '修复登录超时'), message(2, '谢谢')] });
    assert.deepEqual(decision, { refresh: false, reason: 'acknowledgement' });
  });

  it('calls the model on an explicit topic-shift marker', () => {
    const decision = decideTitleRefresh({ ...settled(), messages: [message(1, '修复登录超时'), message(2, '另外，帮我设计一个新的缓存层方案')] });
    assert.deepEqual(decision, { refresh: true, reason: 'topic-shift' });
  });

  it('updates a settled title when a message changes the main task', () => {
    const decision = decideTitleRefresh({ ...settled(), messages: [message(1, '修复登录超时'), message(2, '现在开始部署新的内网代理服务并验证网络连通性')] });
    assert.equal(decision.refresh, true);
  });

  it('calls once for the first provider title evaluation after activation', () => {
    const decision = decideTitleRefresh({ ...settled(), messages: [message(1, '修复登录超时'), message(2, '补充登录超时的排查记录和验证结论说明，并附上日志')] });
    assert.deepEqual(decision, { refresh: true, reason: 'first-provider-title' });
  });

  it('refreshes a provisional title when a new substantive message exists', () => {
    const decision = decideTitleRefresh({
      ...settled({ provisional: true }),
      messages: [message(1, '看看登录问题'), message(2, '补充登录问题的排查记录和验证结论说明，并附上日志')],
    });
    assert.deepEqual(decision, { refresh: true, reason: 'provisional-refinement' });
  });

  it('calls on low lexical overlap against the title and recent messages', () => {
    const decision = decideTitleRefresh({
      ...settled(),
      lastEvaluated: { seq: 1, count: 1 },
      messages: [message(1, '修复登录超时'), message(2, '帮我重构数据同步模块的报名校验逻辑并补充测试')],
    });
    assert.deepEqual(decision, { refresh: true, reason: 'low-overlap' });
  });

  it('periodically audits a session that never drifted explicitly', () => {
    const sameTopic = '排查登录超时的日志信息与登录超时的复现步骤';
    const messages = [message(1, '修复登录超时')];
    for (let index = 0; index < AUDIT_MESSAGE_COUNT; index++) messages.push(message(index + 2, sameTopic));
    const decision = decideTitleRefresh({ ...settled(), lastEvaluated: { seq: 1, count: 1 }, messages });
    assert.deepEqual(decision, { refresh: true, reason: 'periodic-audit' });
  });

  it('audits accumulated new text beyond the byte threshold', () => {
    const long = '排查登录超时的日志信息与登录超时的复现步骤'.repeat(60);
    const decision = decideTitleRefresh({
      ...settled(),
      lastEvaluated: { seq: 1, count: 1 },
      messages: [message(1, '修复登录超时'), message(2, long)],
    });
    assert.ok(Buffer.byteLength(long, 'utf8') >= AUDIT_TEXT_BYTES);
    assert.deepEqual(decision, { refresh: true, reason: 'periodic-audit' });
  });

  it('never re-evaluates messages already covered by the in-memory watermark', () => {
    const decision = decideTitleRefresh({
      ...settled(),
      lastEvaluated: { seq: 2, count: 2 },
      messages: [message(1, '修复登录超时'), message(2, '另外，帮我设计一个新的缓存层方案')],
    });
    assert.deepEqual(decision, { refresh: false, reason: 'already-evaluated' });
  });

  it('always calls for forced explicit refresh and targeted retitle', () => {
    for (const text of ['谢谢', '继续']) {
      const decision = decideTitleRefresh({ ...settled(), forced: true, messages: [message(1, '修复登录超时'), message(2, text)] });
      assert.deepEqual(decision, { refresh: true, reason: 'explicit' });
    }
  });

  it('always calls for recovery, a missing provider title, and a non-canonical title', () => {
    const messages = [message(1, '修复登录超时'), message(2, '谢谢')];
    assert.deepEqual(decideTitleRefresh({ ...settled(), recovery: true, messages }), { refresh: true, reason: 'recovery' });
    assert.deepEqual(
      decideTitleRefresh({ ...settled(), current: { ...provider(), source: { kind: 'fallback' } }, messages }),
      { refresh: true, reason: 'no-provider-title' }
    );
    assert.deepEqual(
      decideTitleRefresh({ ...settled(), current: undefined, messages }),
      { refresh: true, reason: 'no-provider-title' }
    );
    assert.deepEqual(
      decideTitleRefresh({ ...settled(), canonical: false, messages }),
      { refresh: true, reason: 'noncanonical-title' }
    );
  });

  it('keeps a settled title when new messages continue the same topic', () => {
    const decision = decideTitleRefresh({
      ...settled(),
      lastEvaluated: { seq: 1, count: 1 },
      messages: [message(1, '修复登录超时'), message(2, '排查登录超时的日志并确认超时策略与重试预算')],
    });
    assert.deepEqual(decision, { refresh: false, reason: 'stable-title' });
  });

  it('exposes the same decision under the question-shaped alias', () => {
    assert.equal(shouldRefreshTitle, decideTitleRefresh);
  });
});
