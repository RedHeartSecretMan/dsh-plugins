/**
 * Describe why a session's title looks the way it does, in one snapshot.
 *
 * Callers ask one question and get one answer: which rules applied, whether any
 * supplement contributed, where the current title came from, and what failed most
 * recently. The snapshot separates the plugin's built-in rules from optional
 * `AGENTS.md` supplements, so a supplement is never mistaken for the whole rule
 * set, and it never carries provider text.
 *
 * @module session-title-template/title-state
 */

/**
 * Normalize the title source into the three states a person can act on.
 *
 * @param current - Current title record, when the session has one.
 * @returns Title description with an empty value when no title exists.
 */
function describeCurrentTitle(current) {
  if (current === undefined || current === null) {
    return { value: undefined, source: undefined, pinned: false, citedSeqs: [] };
  }
  const kind = current.source?.kind;
  return {
    value: current.title,
    source: kind,
    pinned: kind === 'user',
    citedSeqs: Array.isArray(current.messageSeqs) ? [...current.messageSeqs] : [],
  };
}

/**
 * Summarize how many optional supplements contributed to the prompt.
 *
 * Only sources that actually produced a naming excerpt count, because a discovered
 * file without relevant sections contributes nothing.
 *
 * @param guidance - Instruction reader result, when guidance was read.
 * @returns Supplement description with its contributing sources.
 */
function describeSupplemental(guidance) {
  const sources = Array.isArray(guidance?.sources) ? [...guidance.sources] : [];
  const count = sources.length;
  return {
    count,
    sources,
    summary: count === 0 ? '内置规则' : `内置规则 + ${count} 个补充来源`,
  };
}

/**
 * Pick the newest failure record for one session so the status view explains the
 * last incident without borrowing another session's trouble. Records without a
 * session id cannot be attributed and are ignored.
 *
 * @param records - Structured diagnostics, oldest first.
 * @param sessionId - Session the snapshot describes.
 * @returns Failure description, or null when this session has none.
 */
function describeLastFailure(records, sessionId) {
  const failures = Array.isArray(records)
    ? records.filter(record => record?.kind === 'title-call-failed' && record.sessionId === sessionId)
    : [];
  const latest = failures.at(-1);
  if (latest === undefined) return null;
  return {
    category: latest.category,
    route: latest.route,
    attempt: latest.attempt,
    at: latest.at,
  };
}

/**
 * Build the full title-state snapshot for one session.
 *
 * @param input - Everything known about this session's title.
 * @param input.config - Resolved plugin config supplying the built-in rules.
 * @param input.current - Current title record, when one exists.
 * @param input.guidance - Instruction reader result, when guidance was read.
 * @param input.probe - Role probe verdict, when one was settled.
 * @param input.records - Structured diagnostics for this session.
 * @returns Snapshot separating built-in rules, supplements, title and failures.
 */
export function describeTitleState({ config, current, guidance, probe, records, sessionId } = {}) {
  const supplemental = describeSupplemental(guidance);
  return {
    builtin: {
      template: config.template,
      dateFormat: config.dateFormat,
      timezone: config.timezone,
      types: config.types.map(entry => entry.key),
      fallbackType: config.fallbackType,
      topicMinChars: config.topicMinChars,
      topicMaxChars: config.topicMaxChars,
      cjkSpacing: config.cjkSpacing,
    },
    supplemental: { count: supplemental.count, sources: supplemental.sources },
    summary: supplemental.summary,
    title: describeCurrentTitle(current),
    lastFailure: describeLastFailure(records, sessionId),
    probe: probe === undefined || probe === null ? null : { verdict: probe.verdict, checkedAt: probe.checkedAt },
  };
}
