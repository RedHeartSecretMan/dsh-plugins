import { formatDate, isFormattedTitle } from './title.js';

/** Backfill only closed, idle root sessions; preflight reads never resume an agent. */
export async function backfillTitles(ctx, { config, state, signal, titleOptions, activeRetitles }) {
  const query = ctx.get('sessionQuery');
  const agents = ctx.get('agents');
  if (!query?.readSession || !query.listSessions || !agents?.resume) throw new Error('session-title-agents: backfill needs sessionQuery and agents');
  const progress = await state.read({ signal });
  signal.throwIfAborted();
  const rows = await query.listSessions(signal);
  const targets = new Map(config.backfill.retitle.map(entry => [entry.id, entry]));
  const summary = { updated: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    signal.throwIfAborted();
    const id = String(row.header.id);
    const target = targets.get(id);
    if (row.header.parentSession || (target && progress.retitled[id] === target.hint)) { summary.skipped++; continue; }
    let handle;
    try {
      const observed = await query.readSession(id);
      signal.throwIfAborted();
      const options = titleOptions(formatDate(observed.session.createdAt, config.timezone, config.dateFormat));
      const lastTitle = observed.events.findLast(event => event.type === 'session/title')?.data;
      // Explicit UI refresh can unpin a user title; maintenance never does.
      if (lastTitle?.source?.kind === 'user' || (!target && isFormattedTitle(lastTitle?.title, options))) { summary.skipped++; continue; }
      const lastTurn = observed.events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end');
      if (lastTurn?.type === 'turn/start' || agents.get?.(id)?.status === 'running') { summary.skipped++; continue; }
      let session = ctx.sessions.get(id);
      if (!session) {
        const route = config.backfill.fallbackRoute;
        handle = await agents.resume({ resumeSessionId: id, ...(route ? { agentOptions: route } : {}) });
        session = handle.agent.session;
      }
      signal.throwIfAborted();
      const now = ctx.sessionTitle.get(session);
      if (now?.source?.kind === 'user' || agents.get?.(id)?.status === 'running') { summary.skipped++; continue; }
      if (target) activeRetitles.set(id, target.hint);
      const result = await ctx.sessionTitle.refresh(session, signal);
      signal.throwIfAborted();
      if (!result || result.source?.kind === 'user' || !isFormattedTitle(result.title, options)) throw new Error('session-title-agents: no canonical title was accepted');
      const persisted = await ctx.sessions.flush(session);
      if (persisted === false) throw new Error('session-title-agents: no durable title writer');
      signal.throwIfAborted();
      // Completion means the writer acknowledged the title, not merely generated it.
      if (target) await state.markRetitled(id, target.hint, { signal });
      else await state.markBackfilled(id, { signal });
      summary.updated++;
    } catch (error) {
      signal.throwIfAborted();
      summary.failed++;
      state.note('backfill-session-failed');
    } finally {
      activeRetitles.delete(id);
      // Only this pass owns this handle. Existing user agents are never disposed.
      if (handle) await handle.dispose();
    }
  }
  state.note(`backfill-complete updated=${summary.updated} skipped=${summary.skipped} failed=${summary.failed}`);
  return summary;
}
