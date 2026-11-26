/**
 * Title text: cleaning, CJK spacing, width measurement and topic truncation.
 *
 * Pure string work with no template or prompt knowledge, so truncation and
 * spacing rules can be read and tested without the formatting concerns.
 *
 * @module session-title-template/title/text
 */

/** Accept ASCII brackets and their full-width CJK counterparts. */
export const BRACKET_OPEN = "[\\[\u3010]";

export const BRACKET_CLOSE = "[\\]\u3011]";

/** Characters stripped from both ends of a candidate line before matching. */
export const QUOTE_WRAPPERS = /^["'`\u201c\u201d\u2018\u2019]|["'`\u201c\u201d\u2018\u2019]$/gu;

/** Trailing sentence punctuation removed from the topic. */
export const TRAILING_PUNCTUATION = /[.\u3002!\uff01?\uff1f,\uff0c\u3001;\uff1b:\uff1a]+$/gu;

/** Control characters that must never reach a session title. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/gu;

/** Controls that separate words and therefore become a space, not nothing. */
const WORD_SEPARATING_CONTROLS = /[\t\n\v\f\r\u0085\u2028\u2029]/gu;

/** Asterisk emphasis wrapping a whole line, such as `**Title**`. */
export const EMPHASIS_WRAPPER = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u;

/**
 * Collapse control characters and whitespace into one clean single-line string.
 *
 * @param value - Untrusted text from a model or a prompt.
 * @returns The cleaned text, or an empty string.
 */
export function cleanTitleText(value) {
  if (!value) return "";
  return String(value)
    .replace(WORD_SEPARATING_CONTROLS, " ")
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Insert one half-width space between adjacent CJK and Latin/digit runs.
 *
 * @param value - Text to normalize.
 * @returns The normalized text; unchanged when no boundary is present.
 */
export function formatCjkSpacing(value) {
  if (!value) return "";
  return String(value)
    .replace(/(\p{Script=Han})([A-Za-z0-9])/gu, "$1 $2")
    .replace(/([A-Za-z0-9])(\p{Script=Han})/gu, "$1 $2")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Character limits count Unicode code points, including supplementary Han. */
export function truncateCharacters(value, limit) {
  return Array.from(value).slice(0, limit).join("");
}

const WORD_SEGMENTER = new Intl.Segmenter("zh", { granularity: "word" });

/** Scoped package names (`@scope/pkg`) or contiguous ASCII identifiers (`open-code-review`). */
const ASCII_TOKEN = /(?:@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)/gu;

/** Common two/three-character engineering terms kept whole even when ICU splits them. */
const TECH_TERMS = /重命名|持久化|状态机|工作区|重定向|校验和|排查|网关|超时|文档|优化|缓存|插件|路由|配置|适配|构建|降级|回退|兜底|并发|异步|阻塞|死锁|泄漏|越界|截断|索引|同步|机制/gu;

/**
 * Whole-token sentence-ending punctuation. Prefer stopping at a completed
 * sentence before falling back to a parallel clause or mid-sentence cut.
 */
const SENTENCE_SEPARATOR_TOKENS = new Set(["。", "！", "？", "!", "?"]);

/**
 * Whole-token coordinating separators. Matching compares a segmented token with
 * one of these, so a compound word containing the same character (`合并`,
 * `并发`, `涉及`) is never mistaken for a conjunction.
 */
const CLAUSE_SEPARATOR_TOKENS = new Set(["与", "和", "及", "并", "以及", "同时", "，", "、", "；", ",", ";"]);

/**
 * Whole-token connectors and particles that leave a sentence unfinished when
 * they end a truncated topic. Only an exact token match is stripped, so
 * segmented words such as `存在`, `比对`, and `定向` stay intact.
 */
const DANGLING_TOKENS = new Set(["与", "和", "及", "或", "并", "的", "之", "在", "对", "把", "将", "向", "从"]);

/** Bare connector or clause punctuation left dangling by a cut. */
const CONNECTOR_PUNCTUATION = /^[-/_:,;，、；：。！？!?]+$/u;

/** Half-width ASCII counts as 0.5 CJK width; full-width / Han characters count as 1. */
function charWeight(character) {
  return character.codePointAt(0) <= 0x00ff ? 0.5 : 1;
}

function pushSegmentedUnits(slice, units) {
  for (const { segment } of WORD_SEGMENTER.segment(slice)) {
    if (/^\s+$/u.test(segment)) {
      units.push({ text: segment, weight: 0 });
    } else {
      const chars = Array.from(segment);
      const weight = chars.reduce((sum, ch) => sum + charWeight(ch), 0);
      units.push({ text: segment, weight });
    }
  }
}

function pushCjkUnits(slice, units) {
  let last = 0;
  for (const match of slice.matchAll(TECH_TERMS)) {
    if (match.index > last) pushSegmentedUnits(slice.slice(last, match.index), units);
    const term = match[0];
    units.push({ text: term, weight: Array.from(term).length });
    last = match.index + term.length;
  }
  if (last < slice.length) pushSegmentedUnits(slice.slice(last), units);
}

/** Split topic text into atomic ASCII identifiers and segmented CJK words. */
function tokenizeTopicUnits(text) {
  const units = [];
  let lastIndex = 0;
  for (const match of text.matchAll(ASCII_TOKEN)) {
    if (match.index > lastIndex) pushCjkUnits(text.slice(lastIndex, match.index), units);
    const token = match[0];
    units.push({ text: token, weight: Array.from(token).length * 0.5 });
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) pushCjkUnits(text.slice(lastIndex), units);
  return units;
}

/** Sum one unit sequence's CJK-equivalent width. */
function measureUnits(units) {
  return units.reduce((sum, unit) => sum + unit.weight, 0);
}

/**
 * Measure topic length in CJK-equivalent width units (Han = 1, ASCII = 0.5, spaces = 0).
 *
 * @param value - Topic text.
 * @returns Effective visual width in CJK character units.
 */
export function measureTopicWidth(value) {
  if (!value) return 0;
  return measureUnits(tokenizeTopicUnits(String(value)));
}

/** Drop the empty units a cut can leave at the end of a token sequence. */
function trimTrailingWhiteSpace(units) {
  let end = units.length;
  while (end > 0 && units[end - 1].weight === 0) end--;
  return units.slice(0, end);
}

/** Report whether one unit is a connector that must not end a truncated topic. */
function isDanglingUnit(unit) {
  return DANGLING_TOKENS.has(unit.text) || CONNECTOR_PUNCTUATION.test(unit.text);
}

/** Slice inside one token. Only called when that single token exceeds the whole budget. */
function sliceByWeight(value, limit) {
  let output = "";
  let used = 0;
  for (const ch of Array.from(value)) {
    const weight = /\s/u.test(ch) ? 0 : charWeight(ch);
    if (used + weight > limit) break;
    output += ch;
    used += weight;
  }
  return output.trim();
}

/**
 * Truncate a topic to a CJK-equivalent width budget without splitting words and
 * without leaving an unfinished trailing clause.
 *
 * A token is never split merely to fill the budget; the only split is a single
 * token that by itself exceeds the whole budget, where no whole token can fit.
 *
 * @param value - Cleaned and spaced topic text.
 * @param limit - Maximum CJK-equivalent width (`topicMaxChars`).
 * @returns The truncated topic.
 */
export function hardTruncateTopic(value, limit) {
  if (!value || !(limit > 0)) return value;
  const units = tokenizeTopicUnits(value);
  if (measureUnits(units) <= limit) return value;
  const kept = [];
  let used = 0;
  for (const unit of units) {
    if (used + unit.weight > limit) {
      if (kept.length === 0 && unit.weight > 0) {
        const partial = sliceByWeight(unit.text, limit);
        if (partial) kept.push({ text: partial, weight: measureTopicWidth(partial) });
      }
      break;
    }
    kept.push(unit);
    used += unit.weight;
  }
  return trimTrailingWhiteSpace(kept).map((unit) => unit.text).join('').trim();
}

export function truncateTopic(value, limit) {
  if (!value || !(limit > 0)) return value;
  const units = tokenizeTopicUnits(value);
  if (measureUnits(units) <= limit) return value;

  const kept = [];
  let used = 0;
  let stopIndex = units.length;
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (used + unit.weight > limit) {
      stopIndex = index;
      break;
    }
    kept.push(unit);
    used += unit.weight;
  }

  const minKeep = Math.min(2, limit);
  const lastKept = trimTrailingWhiteSpace(kept).at(-1);
  if (kept.length === 0) {
    // No whole token fits, so slicing this single token is the only option.
    const first = units.find((unit) => unit.weight > 0);
    const partial = first === undefined ? "" : sliceByWeight(first.text, limit);
    if (partial) kept.push({ text: partial, weight: measureTopicWidth(partial) });
  } else if (measureUnits(kept) < minKeep && lastKept !== undefined && isDanglingUnit(lastKept)) {
    // A lone particle such as `在` says nothing; the next whole token is more useful.
    const next = units[stopIndex];
    if (next !== undefined && next.weight > 0) {
      kept.length = 0;
      if (next.weight <= limit) kept.push(next);
      else {
        const partial = sliceByWeight(next.text, limit);
        if (partial) kept.push({ text: partial, weight: measureTopicWidth(partial) });
      }
    }
  }

  // Prefer stopping at a completed sentence inside the budget before falling
  // back to a parallel clause or mid-sentence word boundary.
  let result = trimTrailingWhiteSpace(kept);
  const minClauseWidth = Math.min(6, Math.max(2, Math.floor(limit * 0.4)));
  let completedSentence;
  for (let index = 0; index < result.length; index += 1) {
    const unit = result[index];
    const isSymbolSentenceEnd = SENTENCE_SEPARATOR_TOKENS.has(unit.text);
    const isAsciiSentenceEnd = !isSymbolSentenceEnd
      && /^[A-Za-z0-9_-]*[A-Za-z]\.$/u.test(unit.text)
      && (index + 1 >= result.length || result[index + 1].weight === 0);
    if (!isSymbolSentenceEnd && !isAsciiSentenceEnd) continue;
    const prefix = isAsciiSentenceEnd
      ? trimTrailingWhiteSpace([
        ...result.slice(0, index),
        { text: unit.text.slice(0, -1), weight: Math.max(0, unit.weight - 0.5) },
      ])
      : trimTrailingWhiteSpace(result.slice(0, index));
    if (measureUnits(prefix) >= minClauseWidth) completedSentence = prefix;
  }
  if (completedSentence) {
    result = completedSentence;
  } else {
    // If truncation cut into a second parallel clause, fall back to the completed
    // first clause instead of keeping a phrase whose object is missing.
    let completedPrefix;
    for (let index = 0; index < result.length; index += 1) {
      if (!CLAUSE_SEPARATOR_TOKENS.has(result[index].text)) continue;
      const prefix = trimTrailingWhiteSpace(result.slice(0, index));
      const suffix = trimTrailingWhiteSpace(result.slice(index + 1));
      if (measureUnits(prefix) >= minClauseWidth && measureUnits(suffix) <= 6) completedPrefix = prefix;
    }
    if (completedPrefix) result = completedPrefix;
  }

  // A conjunction or particle left at the very end means the next word was cut
  // away; drop it as long as a usable topic remains.
  while (result.length > 1 && isDanglingUnit(result.at(-1))) {
    const candidate = trimTrailingWhiteSpace(result.slice(0, -1));
    if (candidate.length === 0 || measureUnits(candidate) < minKeep) break;
    result = candidate;
  }

  return trimTrailingWhiteSpace(result).map((unit) => unit.text).join("").trim();
}

/**
 * Normalize topic text. topicMinChars is prompt guidance, not a rejection rule.
 *
 * Shared by model output and delegation labels so both reach the same canonical
 * shape: no trailing punctuation, configured CJK spacing, bounded length.
 */
export function normalizeTopic(value, options) {
  let topic = cleanTitleText(value).replace(TRAILING_PUNCTUATION, "");
  if (options.cjkSpacing) topic = formatCjkSpacing(topic);
  if (options.topicMaxChars > 0) topic = truncateTopic(topic, options.topicMaxChars).trim();
  return topic;
}
