/**
 * Title format: the configured template compiled to a matcher, rendering, and
 * the canonical and lenient readings of a title line.
 *
 * @module session-title-template/title/format
 */

import {
  BRACKET_CLOSE,
  BRACKET_OPEN,
  EMPHASIS_WRAPPER,
  QUOTE_WRAPPERS,
  TRAILING_PUNCTUATION,
  cleanTitleText,
  formatCjkSpacing,
  hardTruncateTopic,
  measureTopicWidth,
  normalizeTopic,
  truncateTopic,
} from './text.js';

const PLACEHOLDER = /\{(date|type|topic)\}/gu;

/**
 * Expand a date format into the resolved date string.
 *
 * @param timestamp - Valid session header.createdAt in milliseconds since the epoch.
 * @param timezone - IANA time zone name already validated by the config layer.
 * @param dateFormat - Format using `YYYY`, `YY`, `MM`, and `DD` tokens.
 * @returns The formatted date, for example `1025`.
 */
export function formatDate(timestamp, timezone, dateFormat) {
  if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) {
    throw new Error("session-title-template: session.header.createdAt must be a valid timestamp in milliseconds");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const year = pick("year");
  return dateFormat
    .replace(/YYYY/gu, year)
    .replace(/YY/gu, year.slice(-2))
    .replace(/MM/gu, pick("month"))
    .replace(/DD/gu, pick("day"));
}

/**
 * Split a title template into literal text and placeholder tokens.
 *
 * @param template - Template such as `[{date}][{type}] {topic}`.
 * @returns Ordered parts, each `{ kind: "literal" }` or `{ kind: "placeholder" }`.
 */
function tokenize(template) {
  const parts = [];
  let last = 0;
  PLACEHOLDER.lastIndex = 0;
  for (let match = PLACEHOLDER.exec(template); match !== null; match = PLACEHOLDER.exec(template)) {
    if (match.index > last) parts.push({ kind: "literal", value: template.slice(last, match.index) });
    parts.push({ kind: "placeholder", name: match[1] });
    last = match.index + match[0].length;
  }
  if (last < template.length) parts.push({ kind: "literal", value: template.slice(last) });
  return parts;
}

/** Escape one character for a regular expression. */
function escapeRegExp(character) {
  return character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Render one literal run as a regex source, tolerating model-added or omitted
 * spacing and the full-width bracket variants of the template's ASCII brackets.
 *
 * Whitespace in the template becomes `\s*` rather than `\s+`: models routinely
 * drop the space after a bracket, and a full-width `】【` boundary has none.
 *
 * @param value - Literal text from the template.
 * @param optionalBrackets - Whether brackets in this run may be omitted, which
 *   lets a title without the date prefix still match the same template.
 * @returns Regex source for the run.
 */
function literalSource(value, optionalBrackets) {
  let source = "";
  for (const character of value) {
    if (/\s/u.test(character)) {
      source += "\\s*";
      continue;
    }
    if (character === "[") {
      source += optionalBrackets ? `(?:${BRACKET_OPEN})?` : BRACKET_OPEN;
      continue;
    }
    if (character === "]") {
      source += optionalBrackets ? `(?:${BRACKET_CLOSE})?` : BRACKET_CLOSE;
      continue;
    }
    source += escapeRegExp(character);
  }
  return source;
}

/**
 * Compile a full template pattern and a secondary omitted-date pattern.
 * Full numeric dates (including separators) are tried first, preventing a
 * trailing date from being swallowed by the topic. Captured dates are replaced
 * by the independently computed creation date.
 *
 * @param template - Title template containing `{type}` and `{topic}`.
 * @param typeKeys - Type vocabulary in effect, used for the alternation.
 * @returns An anchored, case-insensitive regular expression with `date`,
 *   `type`, and `topic` named groups.
 */
export function compileTitlePattern(template, typeKeys) {
  const alternation = [...typeKeys].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  function compile(value, withDate) {
    const source = tokenize(value).map(part => {
      if (part.kind === 'literal') return literalSource(part.value, false);
      if (part.name === 'type') return `(?<type>${alternation})`;
      if (part.name === 'topic') return '(?<topic>.+?)';
      // A date is a numeric rendering (with supported separators), or a model
      // that echoed the format tokens. It must not consume words from a topic.
      return withDate ? '(?<date>(?:[0-9][0-9./_-]{1,15}|[YMD]{2,16}))' : '';
    }).join('');
    return new RegExp(`^\\s*${source}\\s*$`, 'iu');
  }
  const full = compile(template, true);
  const withoutDate = template.replace(/[\[【]\{date\}[\]】]/gu, '').replace(/\{date\}/gu, '').trim();
  full.withoutDate = compile(withoutDate, false);
  return full;
}

/**
 * Try the most unwrapped model output first, retaining intermediate states when
 * quotes, emphasis, headings, or list marks belong to the template itself.
 */
function wrapperCandidates(line) {
  const candidates = new Set([line]);
  const removals = [
    [QUOTE_WRAPPERS, ""],
    [EMPHASIS_WRAPPER, "$<inner>"],
    [/^\*+|\*+$/gu, ""],
    [/^#+\s*/u, ""],
    [/^[-*+]\s+/u, ""],
  ];
  // Branch over independent removals: stripping a heading must not force removal
  // of a trailing asterisk that belongs to the template. Bound unusual nesting.
  for (const current of candidates) {
    for (const [pattern, replacement] of removals) {
      candidates.add(current.replace(pattern, replacement).trim());
      if (candidates.size >= 64) break;
    }
    if (candidates.size >= 64) break;
  }
  return [...candidates].sort((left, right) => left.length - right.length);
}

/**
 * Map a matched type back to its canonical vocabulary key.
 *
 * @param matched - Type text captured from the model output.
 * @param types - Type vocabulary in effect.
 * @returns The canonical key, or `undefined` when nothing matches.
 */
function canonicalType(matched, types) {
  if (typeof matched !== "string") return undefined;
  const lowered = matched.toLowerCase();
  return types.find((entry) => entry.key.toLowerCase() === lowered)?.key;
}

/**
 * Render a title from the template.
 *
 * @param template - Title template.
 * @param values - Resolved `date`, `type`, and `topic` values.
 * @returns The rendered single-line title.
 */
export function renderTitle(template, values) {
  return template
    .replace(PLACEHOLDER, (_match, name) => values[name])
    .replace(/\s+/gu, " ")
    .trim();
}

/** Read exact canonical syntax with the supplied date, without model leniency. */
function readCanonicalTitle(title, options) {
  if (typeof title !== "string" || !title || title !== cleanTitleText(title) ||
      typeof options.date !== "string" || !options.date) return undefined;
  const typeSource = options.types.map((entry) => escapeRegExp(entry.key)).join("|");
  const source = tokenize(options.template.replace(/\s+/gu, " ").trim()).map((part) => {
    if (part.kind === "literal") return escapeRegExp(part.value);
    if (part.name === "date") return escapeRegExp(options.date);
    if (part.name === "type") return `(?<type>${typeSource})`;
    return "(?<topic>.+?)";
  }).join("");
  const groups = new RegExp(`^${source}$`, "u").exec(title)?.groups;
  if (!groups) return undefined;
  const topic = normalizeTopic(groups.topic, options);
  if (!topic || topic !== groups.topic) return undefined;
  const result = { title: renderTitle(options.template, { date: options.date, type: groups.type, topic }), type: groups.type, topic };
  return result.title === title ? result : undefined;
}

/**
 * Read a formatted title out of raw model output.
 *
 * Each non-empty line is tried in order, because models that disregard the
 * one-line instruction usually put the title first. The date the model wrote is
 * discarded in favour of the plugin's own resolved date.
 *
 * @param raw - Raw model output.
 * @param options - Compiled pattern, date, template, types, spacing, and limit.
 * @returns `{ title, type, topic }`, or `undefined` when no line matches.
 */
export function parseModelTitle(raw, options) {
  if (!raw || typeof options.date !== "string" || !options.date) return undefined;
  const { pattern, date, template, types } = options;
  for (const line of String(raw).split(/\r?\n/u)) {
    const cleaned = cleanTitleText(line);
    for (const candidate of wrapperCandidates(cleaned)) {
      if (!candidate) continue;
      const canonical = readCanonicalTitle(candidate, options);
      if (canonical) return canonical;
      const groups = (pattern.exec(candidate) ?? pattern.withoutDate?.exec(candidate))?.groups;
      if (!groups) continue;
      const type = canonicalType(groups.type, types);
      if (type === undefined) continue;
      const topic = normalizeTopic(groups.topic, options);
      if (!topic) continue;
      return { title: renderTitle(template, { date, type, topic }), type, topic };
    }
  }
  return undefined;
}

/**
 * Report whether a title already follows the template.
 *
 * @param title - Existing title text.
 * @param options - Same shape accepted by {@link parseModelTitle}.
 * @returns `true` when the title matches the template with a known type.
 */
export function isFormattedTitle(title, options) {
  return readCanonicalTitle(title, options) !== undefined;
}

/**
 * Report whether a formatted title has settled, which ends automatic refinement.
 *
 * A provisional type such as `探索` keeps the title open to refinement; any
 * concrete type settles it.
 *
 * @param title - Existing title text.
 * @param options - Same shape accepted by {@link parseModelTitle}.
 * @returns `true` when the title is formatted and its type is not provisional.
 */
export function isSettledTitle(title, options) {
  const parsed = readCanonicalTitle(title, options);
  if (!parsed) return false;
  return options.types.find((entry) => entry.key === parsed.type)?.provisional !== true;
}

/**
 * Return the configured refinement window for a canonical provisional title,
 * falling back to `defaultLimit` when the type entry omits `maxRefinements`, or
 * `undefined` when the title is non-canonical or already settled.
 *
 * @param title - Existing title text.
 * @param options - Same shape accepted by {@link parseModelTitle}.
 * @param defaultLimit - Global fallback refinement window.
 * @returns Refinement limit for this provisional type, or `undefined`.
 */
export function provisionalRefinementLimit(title, options, defaultLimit) {
  const parsed = readCanonicalTitle(title, options);
  if (!parsed) return undefined;
  const entry = options.types.find((item) => item.key === parsed.type);
  if (entry?.provisional !== true) return undefined;
  return Number.isInteger(entry.maxRefinements) ? entry.maxRefinements : defaultLimit;
}

/**
 * Build the deterministic fallback title used when no model route is available.
 *
 * @param options - Date, template, fallback type, source text, spacing, limit.
 * @returns A template-shaped title derived from the first user message.
 */
export function buildFallbackTitle(options) {
  const { date, template, fallbackType, sourceText, cjkSpacing, topicMaxChars, fallbackTruncation = 'natural' } = options;
  const limit = topicMaxChars > 0 ? topicMaxChars : 20;
  let topic = cleanTitleText(sourceText).replace(TRAILING_PUNCTUATION, "");
  if (cjkSpacing) topic = formatCjkSpacing(topic);
  // When a multi-line first message overflows the budget (e.g. a brief task line
  // followed by pasted logs or stack traces), prefer the first substantive line
  // before applying natural sentence/word truncation.
  if (typeof sourceText === "string" && /[\r\n]/u.test(sourceText) && measureTopicWidth(topic) > limit) {
    const firstLine = sourceText.split(/\r?\n/u).map((line) => cleanTitleText(line)).find(Boolean);
    if (firstLine) {
      let candidate = firstLine.replace(TRAILING_PUNCTUATION, "");
      if (cjkSpacing) candidate = formatCjkSpacing(candidate);
      const minLineWidth = Math.min(6, Math.max(2, Math.floor(limit * 0.4)));
      if (measureTopicWidth(candidate) >= minLineWidth) {
        topic = candidate;
      }
    }
  }
  topic = (fallbackTruncation === 'hard' ? hardTruncateTopic(topic, limit) : truncateTopic(topic, limit))
    .replace(TRAILING_PUNCTUATION, '').trim();
  return renderTitle(template, { date, type: fallbackType, topic: topic || fallbackType });
}
