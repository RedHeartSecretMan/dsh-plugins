/**
 * Read a subagent's delegation label from its own session log.
 *
 * The delegating agent writes a `subagent/descriptor` event before the first
 * prompt; its `label` is the short task name a human already chose. Reading it
 * lets a subagent session be named from that label instead of from the long task
 * brief that opens its message history.
 *
 * @module session-title-template/delegation
 */

/** Event type carrying the delegation descriptor. */
const DESCRIPTOR_EVENT = 'subagent/descriptor';

/**
 * Return the most recent delegation label carried by a session.
 *
 * A later descriptor replaces an earlier one, so a re-delegated session keeps its
 * current name. Absent, blank, malformed and unreadable sessions all yield
 * `undefined` rather than throwing: naming must never fail because a label is
 * missing.
 *
 * @param session - Session exposing `snapshotEvents()`, when available.
 * @returns Trimmed delegation label, or undefined when the session has none.
 */
export function readDelegationLabel(session) {
  if (session === null || typeof session !== 'object') return undefined;
  if (typeof session.snapshotEvents !== 'function') return undefined;
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return undefined;
  }
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== DESCRIPTOR_EVENT) continue;
    const label = event.data?.label;
    if (typeof label !== 'string') continue;
    const trimmed = label.trim();
    if (trimmed !== '') return trimmed;
  }
  return undefined;
}
