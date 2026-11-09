/**
 * Pure adaptive-refresh policy for automatic session titles.
 *
 * A settled title must not freeze for the rest of a session, but every prompt
 * must not spend a model call either. This module decides from cheap local
 * signals whether a title evaluation is worth one call, and leaves wording to
 * the model behind the system-prompt stability rules.
 *
 * No I/O and no Harness imports, so the policy is unit-testable in isolation.
 *
 * @module session-title-template/refresh-policy
 */

import { cleanTitleText } from './title.js';

/** Messages below this length are too thin to justify an evaluation. */
export const SUBSTANTIVE_MIN_CHARS = 20;

/** A periodic audit runs after this many human messages without an evaluation. */
export const AUDIT_MESSAGE_COUNT = 6;

/** A periodic audit also runs once accumulated new text crosses this size. */
export const AUDIT_TEXT_BYTES = 1500;

/** Share of message tokens that must appear in the references for continuity. */
export const LOW_OVERLAP_RATIO = 0.2;

/**
 * Short acknowledgement, confirmation, and continuation messages. They never
 * justify an automatic refresh by themselves; an explicit topic-shift marker
 * in the same message still wins first.
 */
const ACKNOWLEDGEMENT = /^(?:谢谢|多谢|感谢|好的|好吧|好|行|可以|收到|明白|了解|辛苦了|继续|接着|ok|okay|thanks?|thank you|thx|continue|go on|got it|sure|yes|yep|嗯+|👍)/iu;

/** Explicit signals that the user has moved to a different task or topic. */
const TOPIC_SHIFT = /(?:另外|换个|换一个|换一下|换成|改成|改一下|改为|重新|现在做|现在开始|现在处理|现在改成|接下来|转到|转做|改做|新任务|新的任务|另一个|另外一个|其他问题|其他任务|别的问题|另一个话题|换个话题|换话题|new task|next (?:task|topic)|another (?:task|question|issue)|different (?:task|topic)|something else|instead|switch(?:ing)? to|switch over|now (?:do|work on|handle|let)|move on to|start over|also (?:as )?a new request)/iu;

/** Punctuation, symbols, and whitespace ignored by overlap and ack matching. */
const IGNORABLE = /[\p{P}\p{S}\s]+/gu;

/** Latin words and single Han characters, used as overlap tokens. */
const TOKEN = /[a-z0-9]+/gu;
const HAN = /\p{Script=Han}/gu;

/** Read the largest sequence number a title cites, or zero. */
function citedWatermark(current) {
  const seqs = Array.isArray(current?.messageSeqs) ? current.messageSeqs : [];
  return seqs.reduce((max, seq) => (Number.isSafeInteger(seq) && seq > max ? seq : max), 0);
}

/**
 * Report whether one message is only an acknowledgement or continuation.
 *
 * Short messages starting with ack vocabulary count even when they add a few
 * words ("继续，不要变更标题"); longer messages are treated as substantive, so
 * "好的，现在帮我排查支付回调" is not swallowed by its first word.
 *
 * @param text - Message text.
 * @returns `true` when the message alone should not trigger a refresh.
 */
export function isAcknowledgement(text) {
  const cleaned = cleanTitleText(text);
  if (!cleaned) return true;
  if (cleaned.length > SUBSTANTIVE_MIN_CHARS) return false;
  const normalized = cleaned.replace(IGNORABLE, '');
  if (!normalized) return true;
  return ACKNOWLEDGEMENT.test(normalized);
}

/**
 * Report whether one message asks to work on something else.
 *
 * @param text - Message text.
 * @returns `true` when an explicit topic-shift marker is present.
 */
export function hasTopicShift(text) {
  const cleaned = cleanTitleText(text);
  return cleaned.length > 0 && TOPIC_SHIFT.test(cleaned);
}

/**
 * Report whether one message carries enough content to justify an evaluation.
 *
 * @param text - Message text.
 * @returns `true` when the message is not a short acknowledgement.
 */
export function isSubstantive(text) {
  const cleaned = cleanTitleText(text);
  if (cleaned.length < SUBSTANTIVE_MIN_CHARS) return false;
  return !isAcknowledgement(cleaned);
}

/** Split text into lowercase Latin words and individual Han characters. */
function tokens(text) {
  const normalized = cleanTitleText(text).toLowerCase();
  const result = new Set(normalized.match(TOKEN) ?? []);
  for (const han of normalized.match(HAN) ?? []) result.add(han);
  return result;
}

/**
 * Measure lexical continuity between one message and reference text.
 *
 * @param text - Candidate message text.
 * @param references - Current title and recent message texts.
 * @returns The share of the message's tokens that the references also contain,
 *   from `0` (no shared tokens) to `1` (fully covered), or `1` when the message
 *   has no measurable tokens.
 */
export function lexicalOverlap(text, references = []) {
  const messageTokens = tokens(text);
  if (messageTokens.size === 0) return 1;
  const referenceTokens = new Set();
  for (const reference of references) {
    for (const token of tokens(reference)) referenceTokens.add(token);
  }
  let shared = 0;
  for (const token of messageTokens) if (referenceTokens.has(token)) shared++;
  return shared / messageTokens.size;
}

/** Select the messages not yet covered by the last evaluation. */
function pendingMessages(messages, lastEvaluated, current) {
  const watermark = Number.isSafeInteger(lastEvaluated?.seq) ? lastEvaluated.seq : citedWatermark(current);
  return messages.filter(message => Number.isSafeInteger(message?.seq)
    && message.seq > watermark
    && typeof message.text === 'string'
    && message.text.trim().length > 0);
}

/**
 * Decide whether an automatic title evaluation should call the model.
 *
 * Decision order matters: forced and recovery work must always reach the model,
 * explicit topic-shift markers outrank acknowledgement filtering, and the
 * periodic audit is the last resort for slow drift that no single message makes
 * obvious.
 *
 * @param options - Conversation snapshot and current evaluation state.
 * @param options.messages - All human messages available for this request.
 * @param options.current - Current title record, when one exists.
 * @param options.canonical - Whether the current title follows the template.
 * @param options.provisional - Whether the current title still uses a
 *   provisional type.
 * @param options.forced - Explicit refresh or targeted retitle.
 * @param options.recovery - Current title is a deterministic or legacy fallback.
 * @param options.lastEvaluated - `{ seq, count }` watermark of the last model
 *   evaluation recorded in memory for this session.
 * @returns `{ refresh, reason }`, where `reason` names the deciding rule.
 */
export function decideTitleRefresh({
  messages = [],
  current,
  canonical = false,
  provisional = false,
  forced = false,
  recovery = false,
  lastEvaluated,
} = {}) {
  const answer = (refresh, reason) => ({ refresh, reason });
  if (forced) return answer(true, 'explicit');
  if (recovery) return answer(true, 'recovery');
  if (!current || current.source?.kind !== 'provider') return answer(true, 'no-provider-title');
  if (!canonical) return answer(true, 'noncanonical-title');

  const pending = pendingMessages(messages, lastEvaluated, current);
  if (pending.length === 0) return answer(false, 'already-evaluated');

  if (pending.some(message => hasTopicShift(message.text))) return answer(true, 'topic-shift');

  const substantive = pending.filter(message => isSubstantive(message.text));
  const pendingBytes = pending.reduce((sum, message) => sum + Buffer.byteLength(message.text, 'utf8'), 0);
  const periodic = pending.length >= AUDIT_MESSAGE_COUNT || pendingBytes >= AUDIT_TEXT_BYTES;

  if (substantive.length === 0) {
    if (periodic) return answer(true, 'periodic-audit');
    return answer(false, pending.every(item => isAcknowledgement(item.text)) ? 'acknowledgement' : 'not-substantive');
  }
  if (provisional) return answer(true, 'provisional-refinement');
  // The first evaluation after activation cannot rely on an overlap heuristic:
  // ask once, let the stability rules decide, then trust the cheap rules.
  if (!lastEvaluated) return answer(true, 'first-provider-title');

  const latest = substantive.at(-1);
  const recent = messages
    .filter(message => Number.isSafeInteger(message?.seq) && message.seq < latest.seq && typeof message.text === 'string')
    .slice(-3)
    .map(message => message.text);
  if (lexicalOverlap(latest.text, [current.title, ...recent]) < LOW_OVERLAP_RATIO) return answer(true, 'low-overlap');
  if (periodic) return answer(true, 'periodic-audit');
  return answer(false, 'stable-title');
}

/** Alias kept for callers that name the question rather than the decision. */
export const shouldRefreshTitle = decideTitleRefresh;
