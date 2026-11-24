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

/** Session origin marking a real subagent (never a fork of one). */
const SUBAGENT_ORIGIN = 'subagent';

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
  // A fork replays its ancestor's events as seed, so an inherited descriptor
  // describes the ancestor, not this session. Only a session whose own origin is
  // a subagent may take its name from a descriptor.
  if (session.header?.origin !== SUBAGENT_ORIGIN) return undefined;
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
