import assert from 'node:assert/strict';
import { test } from 'node:test';

const { titleStateProjectionDefinition, SESSION_TITLE_STATE_KEY } = await import('../lib/projection.js');

/** Fold a list of events over the definition's unit, returning the final state. */
function fold(events, header = {}) {
  const { init, apply } = titleStateProjectionDefinition;
  return events.reduce((state, event) => apply(state, event), init(header, 0));
}

/** One `session/title` event with the given source kind. */
function titleEvent(title, kind = 'provider') {
  return {
    type: 'session/title',
    data: { title, messageSeqs: [1], source: kind === 'provider' ? { kind, provider: 'p', model: { provider: 'p', model: 'm' } } : { kind } },
  };
}

test('the projection key is the plugin-owned name, not a host key', () => {
  assert.equal(SESSION_TITLE_STATE_KEY, 'sessionTitleState');
  assert.equal(titleStateProjectionDefinition.key, SESSION_TITLE_STATE_KEY);
});

test('a session with no title event reports an empty state', () => {
  const state = fold([]);
  assert.equal(state.title, null);
  assert.equal(state.source, null);
  assert.equal(state.pinned, false);
});

test('a title event becomes the current title and reports its source', () => {
  const state = fold([titleEvent('[1124][修复] 修复登录超时')]);
  assert.equal(state.title, '[1124][修复] 修复登录超时');
  assert.equal(state.source, 'provider');
  assert.equal(state.pinned, false);
});

test('the newest title event wins, matching the host fold', () => {
  const state = fold([titleEvent('[1124][探索] 第一次'), titleEvent('[1124][修复] 第二次')]);
  assert.equal(state.title, '[1124][修复] 第二次');
});

test('a user title is reported as pinned', () => {
  const state = fold([titleEvent('[1124][文档] 我的标题', 'user')]);
  assert.equal(state.source, 'user');
  assert.equal(state.pinned, true);
});

test('a later automatic title releases the pin', () => {
  const state = fold([titleEvent('[1124][文档] 我的标题', 'user'), titleEvent('[1124][修复] 自动改名')]);
  assert.equal(state.pinned, false);
  assert.equal(state.source, 'provider');
});

test('events the unit does not own return the same state reference', () => {
  const before = fold([titleEvent('[1124][修复] 修复登录超时')]);
  const { apply } = titleStateProjectionDefinition;
  const after = apply(before, { type: 'turn/start', data: { turn: 1 } });
  assert.equal(after, before, 'an unchanged reference means zero downstream work');
});

test('the wire view carries only log-derived fields', () => {
  const { wire } = titleStateProjectionDefinition;
  const state = fold([titleEvent('[1124][修复] 修复登录超时')]);
  const view = wire.view(state);
  assert.deepEqual(Object.keys(view).sort(), ['pinned', 'source', 'title']);
  assert.equal(wire.summary, true, 'session list rows must carry this key');
});

test('the wire view is reference-stable for unchanged state', () => {
  const { wire } = titleStateProjectionDefinition;
  const state = fold([titleEvent('[1124][修复] 修复登录超时')]);
  assert.equal(wire.view(state), wire.view(state));
});

test('the state is plain JSON so the projection cache can checkpoint it', () => {
  const state = fold([titleEvent('[1124][修复] 修复登录超时')]);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});

test('both schemas accept the real shapes and reject wrong ones', () => {
  const { stateSchema, wire } = titleStateProjectionDefinition;
  assert.doesNotThrow(() => stateSchema.parse({ title: '[1124][修复] x', source: 'provider', pinned: false }));
  assert.doesNotThrow(() => stateSchema.parse({ title: null, source: null, pinned: false }));
  assert.throws(() => stateSchema.parse({ title: 42, source: null, pinned: false }));
  assert.throws(() => stateSchema.parse({ title: null, source: 'nonsense', pinned: false }));
  const state = fold([titleEvent('[1124][修复] 修复登录超时')]);
  assert.doesNotThrow(() => wire.viewSchema.parse(wire.view(state)));
});

test('the projection declares a non-negative state version', () => {
  assert.ok(Number.isSafeInteger(titleStateProjectionDefinition.stateVersion));
  assert.ok(titleStateProjectionDefinition.stateVersion >= 0);
});
