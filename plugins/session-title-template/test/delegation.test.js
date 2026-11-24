import assert from 'node:assert/strict';
import { test } from 'node:test';

const { readDelegationLabel } = await import('../lib/delegation.js');

/** Build a session stub exposing the event accessor shapes a real Session has. */
function session(events = []) {
  return { snapshotEvents: () => events };
}

test('a subagent descriptor label becomes the delegation label', () => {
  const label = readDelegationLabel(session([
    { type: 'session' },
    { type: 'subagent/descriptor', data: { label: '起草第 3—4 章', mode: 'continuable' } },
    { type: 'user/message' },
  ]));
  assert.equal(label, '起草第 3—4 章');
});

test('a session without a descriptor has no delegation label', () => {
  assert.equal(readDelegationLabel(session([{ type: 'session' }, { type: 'user/message' }])), undefined);
});

test('a descriptor without a label stays undefined instead of inventing one', () => {
  const label = readDelegationLabel(session([
    { type: 'subagent/descriptor', data: { mode: 'one-shot', provider: 'spawn' } },
  ]));
  assert.equal(label, undefined);
});

test('a blank label is treated as absent', () => {
  const label = readDelegationLabel(session([
    { type: 'subagent/descriptor', data: { label: '   ' } },
  ]));
  assert.equal(label, undefined);
});

test('reading tolerates sessions without the event accessor', () => {
  assert.equal(readDelegationLabel({}), undefined);
  assert.equal(readDelegationLabel(undefined), undefined);
  assert.equal(readDelegationLabel({ snapshotEvents: () => { throw new Error('boom'); } }), undefined);
});

test('the newest descriptor wins so a re-delegated session keeps its current label', () => {
  const label = readDelegationLabel(session([
    { type: 'subagent/descriptor', data: { label: '旧任务' } },
    { type: 'subagent/descriptor', data: { label: '新任务' } },
  ]));
  assert.equal(label, '新任务');
});
