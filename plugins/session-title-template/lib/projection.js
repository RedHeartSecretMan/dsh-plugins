/**
 * The session-title status projection: what the Client can see about a title.
 *
 * The Harness drives session projections for us: a pure `apply` folds committed
 * events into one plain-JSON state per session, and a `wire` block projects that
 * state to the Client. Declaring `summary: true` puts the key on every Session
 * list row, so a row can render a title-status icon without opening the session
 * and without any Remote method of our own.
 *
 * Only log-derived facts travel here. The failure category and probe verdict
 * stay on the Host because they are process-local observations, not history: a
 * restarted Harness has no basis for claiming them, and a cached value would
 * outlive the condition that produced it.
 *
 * @module session-title-template/projection
 */

/** Projection key owned by this plugin; no current host key occupies it. */
export const SESSION_TITLE_STATE_KEY = 'sessionTitleState';

/** Title sources a client can distinguish. Mirrors the host's SessionTitleSource kinds. */
const SOURCE_KINDS = ['fallback', 'provider', 'user'];

/**
 * A structural schema: the projection registry only ever calls `parse`, so a
 * tiny validator is enough and saves a `zod` dependency that a profile-installed
 * plugin cannot resolve anyway.
 *
 * @param check - Predicate deciding whether a value is acceptable.
 * @returns A schema object exposing `parse`, which throws on rejection.
 */
function schema(check) {
  return {
    parse(value) {
      if (!check(value)) throw new TypeError('session-title-template: projection value rejected');
      return value;
    },
  };
}

const isSource = value => value === null || SOURCE_KINDS.includes(value);
const isTitle = value => value === null || typeof value === 'string';
const isPinned = value => typeof value === 'boolean';

/** Written state: the folded title facts. */
const stateSchema = schema(value => value !== null
  && typeof value === 'object'
  && isTitle(value.title)
  && isSource(value.source)
  && isPinned(value.pinned));

/** Client view: the same fields, which is all a row needs. */
const viewSchema = stateSchema;

/** State before any title event lands. */
function initialState() {
  return { title: null, source: null, pinned: false };
}

/**
 * Fold one committed event into the title state.
 *
 * An unrelated event returns the same reference: the registry compares with
 * `Object.is` and does nothing when the reference is unchanged, so returning a
 * fresh object here would make every event look like a title change.
 *
 * @param state - State covering all prior events.
 * @param event - Next committed session event.
 * @returns The next state, or the same state when the event is not ours.
 */
function apply(state, event) {
  if (event?.type !== 'session/title') return state;
  const source = event.data?.source?.kind;
  return {
    title: typeof event.data.title === 'string' ? event.data.title : null,
    source: isSource(source) ? source : null,
    // Pinning is the host's own rule: a user-sourced title pins the session.
    pinned: source === 'user',
  };
}

/**
 * The projection definition handed to `ctx.sessionProjections.register()`.
 *
 * `stateVersion` must be bumped when the folded fields or their meaning change:
 * it invalidates persisted checkpoints that would otherwise seed a stale shape.
 */
export const titleStateProjectionDefinition = {
  key: SESSION_TITLE_STATE_KEY,
  stateVersion: 1,
  stateSchema,
  init: () => initialState(),
  apply,
  wire: {
    viewSchema,
    view: state => state,
    summary: true,
  },
};
