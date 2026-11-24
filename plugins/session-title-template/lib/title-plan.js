/**
 * Title planning: decide whether a session needs a fresh title, without I/O.
 *
 * This is the decision half of the provider. It reads the conversation snapshot
 * and the current title record, then answers what should happen next: keep the
 * existing title, or generate a new one from these messages. Everything it needs
 * arrives as a plain object, so the rules are testable without a session, a
 * model route or the filesystem.
 *
 * @module session-title-template/title-plan
 */

import { buildFallbackTitle, isFormattedTitle, isSettledTitle, normalizeTopic, renderTitle } from './title.js';
import { decideTitleRefresh } from './refresh-policy.js';

/**
 * Build the fallback title a session shows before the model answers.
 *
 * @param options - Resolved title options for this session's creation date.
 * @param sourceText - First human message text.
 * @returns Formatted fallback title.
 */
function fallbackTitle(options, sourceText) {
  return buildFallbackTitle({
    date: options.date,
    template: options.template,
    fallbackType: options.fallbackType,
    sourceText,
    cjkSpacing: options.cjkSpacing,
    topicMaxChars: options.topicMaxChars,
  });
}

/**
 * Report whether the current title is a deterministic fallback that must be replaced.
 *
 * A first-message truncation has never demonstrated a useful summary, and legacy
 * versions could label such a title as provider output, so both shapes count.
 *
 * @param current - Current title record, when one exists.
 * @param fallback - Fallback title built for this session.
 * @param options - Resolved title options.
 * @returns `true` when the title must be regenerated.
 */
function needsRecovery(current, fallback, options) {
  if (current?.title === fallback) return true;
  return current?.source?.kind === 'provider'
    && !current.source.model
    && isFormattedTitle(current.title, options)
    && fallback.startsWith(current.title);
}

/**
 * Build a title from a subagent's delegation label.
 *
 * Subagent first messages are long task briefs, so summarizing them costs a model
 * call and often yields a title that reads like the brief. The delegation label is
 * the one short phrase that already describes the task, so it names the session
 * directly and a later refinement can supply the precise type.
 *
 * @param label - Delegation label, when the session carries one.
 * @param options - Resolved title options for this session's creation date.
 * @returns Formatted title, or undefined when no usable label exists.
 */
function delegationTitle(label, options) {
  if (typeof label !== 'string') return undefined;
  // Reuse the same normalization the model path applies, so a label such as
  // "修复登录：超时重试。" yields a canonical title rather than one the parser
  // would reject if it ever came back from the model.
  const topic = normalizeTopic(label, options);
  if (!topic) return undefined;
  return renderTitle(options.template, { date: options.date, type: options.fallbackType, topic });
}

/**
 * Decide what the provider should do for one session.
 *
 * @param context - Conversation snapshot and control flags.
 * @param context.messages - Human messages available for this request.
 * @param context.current - Current title record, when the session already has one.
 * @param context.options - Resolved title options carrying the session date.
 * @param context.explicitRefresh - The refresh tool asked for a regeneration.
 * @param context.targeted - A targeted retitle asked for a specific hint.
 * @param context.hint - Retitle hint, when one applies.
 * @param context.lastEvaluated - Watermark of the last model evaluation, if known.
 * @returns The plan: whether to refresh, why, and everything later stages need.
 */
export function planTitle(context) {
  const { messages, current, options, explicitRefresh = false, targeted = false, hint, lastEvaluated } = context;
  const forced = targeted || explicitRefresh;
  const fallback = fallbackTitle(options, messages[0].text);
  const canonical = current === undefined ? false : isFormattedTitle(current.title, options);
  const decision = decideTitleRefresh({
    messages,
    current,
    canonical,
    provisional: canonical && current !== undefined && !isSettledTitle(current.title, options),
    forced,
    recovery: needsRecovery(current, fallback, options),
    lastEvaluated,
  });
  // A subagent names itself from the delegation label; every other session falls
  // back to the message-derived title and needs the model for a real title.
  // Delegation identity is decided by the caller from the session header; a label
  // alone never implies a subagent, because a fork can carry an inherited one.
  const delegated = context.isSubagent === true ? delegationTitle(context.delegationLabel, options) : undefined;
  return {
    refresh: decision.refresh,
    reason: decision.reason,
    source: delegated === undefined ? 'messages' : 'delegation-label',
    delegationTitle: delegated,
    forced,
    targeted,
    explicitRefresh,
    hint: hint ?? (explicitRefresh
      ? 'Explicit refresh: reconsider the session topic; do not keep a poor title merely because its format is valid.'
      : undefined),
    fallback,
    canonical,
    currentTitle: current === undefined ? undefined : { title: current.title, canonical },
  };
}
