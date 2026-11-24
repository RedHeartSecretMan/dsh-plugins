import assert from 'node:assert/strict';
import { test } from 'node:test';

const { registerBackfillTool } = await import('../lib/backfill-tool.js');

/** Build a context that records the registered tool and its effects. */
function fixture({ candidates = [], applied } = {}) {
  const tools = [];
  const ctx = {
    tools: { register: definition => { tools.push(definition); return () => {}; } },
  };
  registerBackfillTool(ctx, {
    plan: async () => ({ candidates, skipped: [] }),
    apply: async (_ctx, _deps, ids) => applied ?? { updated: ids, failed: [] },
  });
  assert.equal(tools.length, 1);
  const tool = tools[0];
  const run = args => tool.execute(args, { signal: new AbortController().signal });
  return { tool, run };
}

test('the tool declares exactly a preview flag and the ids to apply', () => {
  const { tool } = fixture();
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['dryRun', 'ids']);
  assert.deepEqual(tool.parameters.required ?? [], []);
  assert.equal(tool.parameters.additionalProperties, false);
});

test('the default call previews instead of writing', async () => {
  const { run } = fixture({ candidates: [{ id: 'A', reason: 'no-canonical-title' }] });
  const result = await run({});
  assert.equal(result.dryRun, true);
  assert.equal(result.candidates.length, 1);
  assert.match(result.text, /A/u);
});

test('a preview lists each candidate with why it qualifies', async () => {
  const { run } = fixture({
    candidates: [
      { id: 'A', reason: 'no-canonical-title', currentTitle: '帮我写一篇文章' },
      { id: 'B', reason: 'targeted-retitle' },
    ],
  });
  const result = await run({ dryRun: true });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.text.includes('帮我写一篇文章'), true);
});

test('a preview with nothing to do says so', async () => {
  const { run } = fixture({ candidates: [] });
  const result = await run({ dryRun: true });
  assert.match(result.text, /没有|无需/u);
  assert.equal(result.candidates.length, 0);
});

test('applying retitles only the previewed sessions', async () => {
  const calls = [];
  const { run } = fixture({
    candidates: [{ id: 'A', reason: 'no-canonical-title' }],
    applied: { updated: ['A'], failed: [] },
  });
  const result = await run({ dryRun: false, ids: ['A'] });
  assert.deepEqual(result.updated, ['A']);
  assert.equal(result.dryRun, false);
  assert.equal(calls.length, 0);
});

test('applying without ids is refused, so a write is never implicit', async () => {
  const { run } = fixture({ candidates: [{ id: 'A', reason: 'no-canonical-title' }] });
  const result = await run({ dryRun: false });
  assert.match(result.text, /预览|ids/u);
  assert.deepEqual(result.updated, []);
});
