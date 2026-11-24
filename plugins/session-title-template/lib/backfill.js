/**
 * Historical title maintenance, split into a read-only preview and an apply.
 *
 * A person decides what to change, so the two halves are separate: `planBackfill`
 * reads eligibility and writes nothing, and `applyBackfill` only touches the ids
 * the caller names. Startup maintenance reuses both, so there is one eligibility
 * rule rather than one per entry point.
 *
 * @module session-title-template/backfill
 */

import { formatDate, isFormattedTitle } from './title.js';

/** Services backfill cannot work without. */
function services(ctx) {
  const query = ctx.get('sessionQuery');
  const agents = ctx.get('agents');
  if (!query?.readSession || !query.listSessions || !agents?.resume) {
    throw new Error('session-title-template: backfill needs sessionQuery and agents');
  }
  return { query, agents };
}

/** Build the per-session title options from an observed creation time. */
function optionsFor(observed, config, titleOptions) {
  return titleOptions(formatDate(observed.session.createdAt, config.timezone, config.dateFormat));
}

/**
 * Read one session's eligibility for backfill.
 *
 * Returns a reason naming why it is ineligible, or a candidate describing the
 * change a person would be approving. Read-only: it never resumes an agent.
 *
 * @param ctx - Plugin context carrying `sessionQuery` and `agents`.
 * @param args - Config, the pass's progress snapshot, and title options.
 * @param row - A row from `listSessions`.
 * @returns `{ candidate }` or `{ skip }`.
 */
async function inspect(ctx, { config, progress, titleOptions }, row) {
  const { query, agents } = services(ctx);
  const id = String(row.header.id);
  if (row.header.parentSession || row.header.origin === 'subagent') {
    return { skip: { id, reason: 'subagent' } };
  }
  const target = config.backfill.retitle.find(entry => entry.id === id);
  if (target !== undefined && progress.retitled[id] === target.hint) {
    return { skip: { id, reason: 'already-retitled' } };
  }
  const observed = await query.readSession(id);
  const options = optionsFor(observed, config, titleOptions);
  const lastTitle = observed.events.findLast(event => event.type === 'session/title')?.data;
  // An explicit user title is a decision already made; maintenance never overrides it.
  if (lastTitle?.source?.kind === 'user') return { skip: { id, reason: 'pinned' } };
  if (target === undefined && isFormattedTitle(lastTitle?.title, options)) {
    return { skip: { id, reason: 'canonical' } };
  }
  const lastTurn = observed.events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end');
  if (lastTurn?.type === 'turn/start' || agents.get?.(id)?.status === 'running') {
    return { skip: { id, reason: 'running' } };
  }
  return {
    candidate: {
      id,
      reason: target === undefined ? 'no-canonical-title' : 'targeted-retitle',
      currentTitle: typeof lastTitle?.title === 'string' ? lastTitle.title : undefined,
      ...(target === undefined ? {} : { hint: target.hint }),
    },
  };
}

/**
 * List what backfill would change, without changing it.
 *
 * @param ctx - Plugin context.
 * @param args - `{ config, state, titleOptions, signal }`.
 * @returns `{ candidates, skipped }`, both ordered as the session list is.
 */
export async function planBackfill(ctx, { config, state, titleOptions, signal } = {}) {
  const { query } = services(ctx);
  const rows = await query.listSessions(signal);
  // One read for the whole pass: eligibility does not depend on other rows, and
  // re-reading per row cost a lock wait and a JSON parse each time.
  const progress = await state.read({ signal });
  const candidates = [];
  const skipped = [];
  for (const row of rows) {
    signal?.throwIfAborted();
    const result = await inspect(ctx, { config, progress, titleOptions }, row);
    if (result.candidate !== undefined) candidates.push(result.candidate);
    else skipped.push(result.skip);
  }
  return { candidates, skipped };
}

/**
 * Regenerate the titles of exactly the sessions the caller names.
 *
 * Completion means the durable writer acknowledged the title, not merely that a
 * model produced one: a title that cannot be persisted stays a failure.
 *
 * @param ctx - Plugin context.
 * @param args - `{ config, state, titleOptions, activeRetitles, signal }`.
 * @param ids - Session ids to retitle; anything else is ignored.
 * @returns Counts of updates and failures per id.
 */
export async function applyBackfill(ctx, { config, state, titleOptions, activeRetitles, signal } = {}, ids) {
  const { query, agents } = services(ctx);
  const wanted = new Set((ids ?? []).map(String));
  const summary = { updated: [], failed: [] };
  if (wanted.size === 0) return summary;
  const rows = await query.listSessions(signal);
  const progress = await state.read({ signal });
  for (const row of rows) {
    signal?.throwIfAborted();
    const id = String(row.header.id);
    if (!wanted.has(id)) continue;
    // Re-check eligibility at apply time: a session can start running between
    // the preview and the confirmation.
    const result = await inspect(ctx, { config, progress, titleOptions }, row);
    if (result.candidate === undefined) {
      summary.failed.push({ id, reason: result.skip.reason });
      continue;
    }
    let handle;
    try {
      const options = optionsFor(await query.readSession(id), config, titleOptions);
      let session = ctx.sessions.get(id);
      if (!session) {
        const route = config.backfill.fallbackRoute;
        handle = await agents.resume({ resumeSessionId: id, ...(route ? { agentOptions: route } : {}) });
        session = handle.agent.session;
      }
      signal?.throwIfAborted();
      const now = ctx.sessionTitle.get(session);
      if (now?.source?.kind === 'user') {
        summary.failed.push({ id, reason: 'pinned' });
        continue;
      }
      if (result.candidate.hint !== undefined) activeRetitles.set(id, result.candidate.hint);
      const title = await ctx.sessionTitle.refresh(session, signal);
      signal?.throwIfAborted();
      if (!title || title.source?.kind === 'user' || !isFormattedTitle(title.title, options)) {
        throw new Error('session-title-template: no canonical title was accepted');
      }
      const persisted = await ctx.sessions.flush(session);
      if (persisted === false) throw new Error('session-title-template: no durable title writer');
      signal?.throwIfAborted();
      if (result.candidate.hint !== undefined) await state.markRetitled(id, result.candidate.hint, { signal });
      else await state.markBackfilled(id, { signal });
      summary.updated.push(id);
    } catch (error) {
      signal?.throwIfAborted();
      summary.failed.push({ id, reason: 'error' });
      state.note('backfill-session-failed');
    } finally {
      activeRetitles.delete(id);
      // Only this pass owns this handle. Existing user agents are never disposed.
      if (handle) await handle.dispose();
    }
  }
  state.note(`backfill-complete updated=${summary.updated.length} failed=${summary.failed.length}`);
  return summary;
}

/**
 * Run the startup maintenance pass over every eligible session.
 *
 * Deliberately a thin composition of the two phases, so the opt-in tool and the
 * automatic pass cannot disagree about eligibility.
 *
 * @param ctx - Plugin context.
 * @param args - `{ config, state, titleOptions, activeRetitles, signal }`.
 * @returns Summary counts.
 */
export async function backfillTitles(ctx, { config, state, signal, titleOptions, activeRetitles }) {
  const plan = await planBackfill(ctx, { config, state, titleOptions, signal });
  signal?.throwIfAborted();
  if (plan.candidates.length === 0) {
    state.note('backfill-complete updated=0 failed=0');
    return { updated: 0, skipped: plan.skipped.length, failed: 0 };
  }
  const result = await applyBackfill(
    ctx,
    { config, state, titleOptions, activeRetitles, signal },
    plan.candidates.map(entry => entry.id),
  );
  return { updated: result.updated.length, skipped: plan.skipped.length, failed: result.failed.length };
}
