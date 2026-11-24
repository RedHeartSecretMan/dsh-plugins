import assert from 'node:assert/strict';
import { test } from 'node:test';

const { planBackfill } = await import('../lib/backfill.js');
const { resolveConfig } = await import('../lib/config.js');
const { compileTitlePattern, formatDate } = await import('../lib/title.js');

const config = resolveConfig({});
const pattern = compileTitlePattern(config.template, config.types.map(entry => entry.key));

/** The same option builder the plugin passes in, so eligibility matches production. */
const titleOptions = date => ({
  pattern,
  date,
  template: config.template,
  types: config.types,
  fallbackType: config.fallbackType,
  cjkSpacing: config.cjkSpacing,
  topicMaxChars: config.topicMaxChars,
});

/** A session row as the query service lists it. */
function row(id, extra = {}) {
  return { header: { id, createdAt: 1_700_000_000_000, ...extra } };
}

/**
 * Build a query service over a fixed set of sessions.
 *
 * `events` maps a session id to the events `readSession` should report, which
 * is where eligibility comes from: a session with a user title or a running
 * turn is ineligible.
 */
function fixture({ rows, events = {}, running = [] } = {}) {
  const resumed = [];
  const refreshed = [];
  const flushed = [];
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => rows,
          readSession: async id => ({ session: { id, createdAt: 1_700_000_000_000 }, events: events[id] ?? [] }),
        };
      }
      if (name === 'agents') {
        return {
          resume: async ({ resumeSessionId }) => {
            resumed.push(resumeSessionId);
            return { agent: { session: { id: resumeSessionId } }, dispose: async () => {} };
          },
          get: id => (running.includes(id) ? { status: 'running' } : undefined),
        };
      }
      return undefined;
    },
    sessions: { get: () => undefined, flush: async session => { flushed.push(session.id); return true; } },
    sessionTitle: {
      get: () => undefined,
      refresh: async session => {
        refreshed.push(session.id);
        return { title: '[1124][修复] 补的标题', source: { kind: 'provider' } };
      },
    },
  };
  return { ctx, resumed, refreshed, flushed };
}

const state = {
  read: async () => ({ backfilled: [], retitled: {} }),
  note: () => {},
  markBackfilled: async () => {},
  markRetitled: async () => {},
};

test('previewing lists eligible sessions without writing anything', async () => {
  const f = fixture({ rows: [row('A'), row('B')] });
  const plan = await planBackfill(f.ctx, { config, state, titleOptions });
  assert.deepEqual(plan.candidates.map(entry => entry.id), ['A', 'B']);
  assert.equal(plan.candidates[0].reason, 'no-canonical-title');
  assert.deepEqual(f.resumed, [], 'a preview must not resume an agent');
  assert.deepEqual(f.refreshed, [], 'a preview must not regenerate a title');
  assert.deepEqual(f.flushed, []);
});

test('subagent sessions are never offered', async () => {
  const f = fixture({ rows: [row('A'), row('S', { parentSession: 'A', origin: 'subagent' })] });
  const plan = await planBackfill(f.ctx, { config, state, titleOptions });
  assert.deepEqual(plan.candidates.map(entry => entry.id), ['A']);
  assert.equal(plan.skipped.find(entry => entry.id === 'S').reason, 'subagent');
});

test('a pinned user title is never offered', async () => {
  const f = fixture({
    rows: [row('A')],
    events: { A: [{ type: 'session/title', data: { title: '[1124][文档] 我的标题', source: { kind: 'user' } } }] },
  });
  const plan = await planBackfill(f.ctx, { config, state, titleOptions });
  assert.deepEqual(plan.candidates, []);
  assert.equal(plan.skipped.find(entry => entry.id === 'A').reason, 'pinned');
});

test('a running session is never offered', async () => {
  const f = fixture({ rows: [row('A')], running: ['A'] });
  const plan = await planBackfill(f.ctx, { config, state, titleOptions });
  assert.deepEqual(plan.candidates, []);
  assert.equal(plan.skipped.find(entry => entry.id === 'A').reason, 'running');
});

test('a session left mid-turn is never offered', async () => {
  const f = fixture({ rows: [row('A')], events: { A: [{ type: 'turn/start', data: { turn: 1 } }] } });
  const plan = await planBackfill(f.ctx, { config, state, titleOptions });
  assert.deepEqual(plan.candidates, []);
  assert.equal(plan.skipped.find(entry => entry.id === 'A').reason, 'running');
});

test('a session that already carries a canonical title is never offered', async () => {
  const f = fixture({
    rows: [row('A')],
    events: { A: [{ type: 'session/title', data: { title: '[1115][修复] 已有标题', source: { kind: 'provider' } } }] },
  });
  const plan = await planBackfill(f.ctx, { config, state, titleOptions });
  assert.deepEqual(plan.candidates, []);
  assert.equal(plan.skipped.find(entry => entry.id === 'A').reason, 'canonical');
});

test('the candidate carries the current title so a person can judge the change', async () => {
  const f = fixture({
    rows: [row('A')],
    events: { A: [{ type: 'session/title', data: { title: '帮我写一篇文章', source: { kind: 'fallback' } } }] },
  });
  const plan = await planBackfill(f.ctx, { config, state, titleOptions });
  assert.equal(plan.candidates[0].currentTitle, '帮我写一篇文章');
});
