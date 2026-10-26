/**
 * Configuration defaults and validation. Kept independent of Harness imports
 * so invalid profile values fail clearly at activation without dependencies.
 * @module session-title-agents/config
 */

const DEFAULT_TYPES = [
  { key: "功能", hint: "新增能力、开发新功能、新增特性" },
  { key: "设计", hint: "制定架构方案、技术方案规划、接口设计" },
  { key: "修复", hint: "排障纠错、解决报错、分析异常、Bug 修复" },
  { key: "优化", hint: "重构代码、改进性能或体验、调整命名、规范格式" },
  { key: "发布", hint: "版本交付、构建打包、发布上线" },
  { key: "运维", hint: "部署配置、服务启停、环境依赖、网络代理、资产维护" },
  { key: "探索", hint: "理解现状、技术咨询、用法了解、概念释义、信息不足时的初步试探", provisional: true },
  { key: "文档", hint: "编写材料、技术文档、PPT 幻灯片、报告整理" },
  { key: "研究", hint: "多渠道调研、方案对比、指标评测比较、投研分析" },
];

/** Canonical public configuration keys and their defaults. */
export const DEFAULTS = {
  template: "[{date}][{type}] {topic}",
  dateFormat: "MMDD",
  timezone: "Asia/Shanghai",
  language: "zh",
  cjkSpacing: true,
  topicMinChars: 8,
  topicMaxChars: 18,
  fallbackType: "探索",
  types: DEFAULT_TYPES,
  provider: undefined,
  model: undefined,
  maxInputBytes: 4096,
  maxOutputTokens: 4096,
  timeoutMs: 60000,
  maxProvisionalRefinements: 4,
  agentsInstructions: { enabled: true, maxBytes: 4096 },
  backfill: { enabled: false },
};

function invalid(field, expectation) {
  throw new Error(`session-title-agents: config.${field} ${expectation}`);
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) invalid(field, "must be a non-empty string");
  return value.trim();
}

function requireInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    invalid(field, `must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function rejectUnknown(record, keys, field = "") {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) invalid(field ? `${field}.${key}` : key, "is an unknown key");
  }
}

function optionalHint(value, field) {
  if (value === undefined) return "";
  if (typeof value !== "string") invalid(field, "must be a string");
  return value;
}

function normalizeType(entry, index) {
  const field = `types[${index}]`;
  const record = typeof entry === "string" ? { key: entry } : entry;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    invalid(field, "must be a string or an object with a key");
  }
  rejectUnknown(record, ["key", "hint", "provisional"], field);
  // Check the untrimmed input too: a newline must not disappear during trim.
  if (typeof record.key === "string" && /[{}[\]【】\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(record.key)) {
    invalid(`${field}.key`, "must not contain braces, brackets, or control characters");
  }
  const key = requireString(record.key, `${field}.key`);
  const hint = optionalHint(record.hint, `${field}.hint`);
  if (record.provisional !== undefined && typeof record.provisional !== "boolean") {
    invalid(`${field}.provisional`, "must be a boolean");
  }
  return { key, hint, ...(record.provisional === true ? { provisional: true } : {}) };
}

function validateTemplate(template) {
  const value = requireString(template, "template");
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(template)) invalid("template", "must not contain control characters");
  for (const placeholder of ["date", "type", "topic"]) {
    const count = value.split(`{${placeholder}}`).length - 1;
    if (count === 0) invalid("template", `must contain {${placeholder}} exactly once`);
    if (count !== 1) invalid("template", `must contain {${placeholder}} exactly once`);
  }
  if (/[{}]/u.test(value.replace(/\{(?:date|type|topic)\}/gu, ""))) {
    invalid("template", "may only use {date}, {type}, and {topic}; unmatched braces are not allowed");
  }
  if (/\{(?:date|type|topic)\}\{(?:date|type|topic)\}/u.test(value)) invalid('template', 'must separate adjacent placeholders with literal text');
  return value;
}

function validateDateFormat(dateFormat) {
  const value = requireString(dateFormat, "dateFormat");
  if (!value.includes("MM") || !value.includes("DD")) {
    invalid("dateFormat", "must contain MM and DD; the year is optional");
  }
  if (value.length > 16 || !/^(?:YYYY|YY|MM|DD|[-/._])+$/u.test(value)) {
    invalid("dateFormat", "must spell the year as YYYY or YY and use only complete YYYY, YY, MM, DD tokens or - / . _ separators");
  }
  return value;
}

function validateTimezone(timezone) {
  const value = requireString(timezone, "timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  } catch {
    invalid("timezone", `is not a time zone this runtime knows: ${value}`);
  }
  return value;
}

function normalizeRoute(route, field) {
  if (route === undefined || route === null) return undefined;
  if (typeof route !== "object" || Array.isArray(route)) invalid(field, "must be an object with provider and model");
  rejectUnknown(route, ["provider", "model"], field);
  return Object.freeze({
    provider: requireString(route.provider, `${field}.provider`),
    model: requireString(route.model, `${field}.model`),
  });
}

function normalizeRetitle(value, field) {
  if (!Array.isArray(value)) invalid(field, "must be an array");
  return value.map((entry, index) => {
    const entryField = `${field}[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      invalid(entryField, "must be an object with an id");
    }
    rejectUnknown(entry, ["id", "hint"], entryField);
    return {
      id: requireString(entry.id, `${entryField}.id`),
      hint: optionalHint(entry.hint, `${entryField}.hint`),
    };
  });
}

/** Resolve canonical configuration, including the two supported legacy aliases. */
export function resolveConfig(config) {
  const raw = config === undefined || config === null ? {} : config;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("session-title-agents: config must be an object");
  rejectUnknown(raw, [...Object.keys(DEFAULTS), "maxExploreRefinements", "retitle"]);

  const types = raw.types === undefined ? DEFAULTS.types : raw.types;
  if (!Array.isArray(types) || types.length < 2) invalid("types", "must list at least two types");
  const normalizedTypes = types.map(normalizeType);
  const keys = normalizedTypes.map((entry) => entry.key);
  if (new Set(keys.map((key) => key.toLowerCase())).size !== keys.length) invalid("types", "must not repeat a key (case-insensitive)");

  const language = raw.language === undefined ? DEFAULTS.language : raw.language;
  if (language !== "zh" && language !== "en") invalid("language", 'must be "zh" or "en"');
  const template = validateTemplate(raw.template === undefined ? DEFAULTS.template : raw.template);
  const dateFormat = validateDateFormat(raw.dateFormat === undefined ? DEFAULTS.dateFormat : raw.dateFormat);
  const timezone = validateTimezone(raw.timezone === undefined ? DEFAULTS.timezone : raw.timezone);
  const fallbackType = raw.fallbackType === undefined ? DEFAULTS.fallbackType : raw.fallbackType;
  if (!keys.includes(fallbackType)) invalid("fallbackType", "must be one of the configured types");
  const cjkSpacing = raw.cjkSpacing === undefined ? DEFAULTS.cjkSpacing : raw.cjkSpacing;
  if (typeof cjkSpacing !== "boolean") invalid("cjkSpacing", "must be a boolean");

  const topicMinChars = requireInteger(raw.topicMinChars === undefined ? DEFAULTS.topicMinChars : raw.topicMinChars, "topicMinChars", 1, 200);
  const topicMaxChars = requireInteger(raw.topicMaxChars === undefined ? DEFAULTS.topicMaxChars : raw.topicMaxChars, "topicMaxChars", 1, 200);
  if (topicMaxChars < topicMinChars) invalid("topicMaxChars", "must not be smaller than topicMinChars");

  if ((raw.provider === undefined) !== (raw.model === undefined)) invalid("provider", "and config.model must be supplied together");
  const agentsInstructionsRaw = raw.agentsInstructions === undefined ? {} : raw.agentsInstructions;
  if (typeof agentsInstructionsRaw !== "object" || agentsInstructionsRaw === null || Array.isArray(agentsInstructionsRaw)) {
    invalid("agentsInstructions", "must be an object");
  }
  rejectUnknown(agentsInstructionsRaw, ["enabled", "maxBytes"], "agentsInstructions");
  const agentsInstructionsEnabled = agentsInstructionsRaw.enabled === undefined
    ? DEFAULTS.agentsInstructions.enabled : agentsInstructionsRaw.enabled;
  if (typeof agentsInstructionsEnabled !== "boolean") invalid("agentsInstructions.enabled", "must be a boolean");
  const agentsInstructionsMaxBytes = requireInteger(
    agentsInstructionsRaw.maxBytes === undefined ? DEFAULTS.agentsInstructions.maxBytes : agentsInstructionsRaw.maxBytes,
    "agentsInstructions.maxBytes", 256, 65536,
  );

  const backfillRaw = raw.backfill === undefined || raw.backfill === null ? {} : raw.backfill;
  if (typeof backfillRaw !== "object" || Array.isArray(backfillRaw)) invalid("backfill", "must be an object");
  rejectUnknown(backfillRaw, ["enabled", "fallbackRoute", "retitle"], "backfill");
  const backfillEnabled = backfillRaw.enabled === undefined ? DEFAULTS.backfill.enabled : backfillRaw.enabled;
  if (typeof backfillEnabled !== "boolean") invalid("backfill.enabled", "must be a boolean");
  const backfillRoute = normalizeRoute(backfillRaw.fallbackRoute, "backfill.fallbackRoute");
  const legacyRetitle = raw.retitle === undefined ? undefined : normalizeRetitle(raw.retitle, "retitle");
  const retitleEntries = backfillRaw.retitle === undefined
    ? legacyRetitle ?? []
    : normalizeRetitle(backfillRaw.retitle, "backfill.retitle");
  if (legacyRetitle !== undefined && backfillRaw.retitle !== undefined && JSON.stringify(legacyRetitle) !== JSON.stringify(retitleEntries)) {
    invalid("retitle", "conflicts with config.backfill.retitle");
  }
  if (raw.maxExploreRefinements !== undefined && raw.maxProvisionalRefinements !== undefined &&
      raw.maxExploreRefinements !== raw.maxProvisionalRefinements) {
    invalid("maxExploreRefinements", "conflicts with config.maxProvisionalRefinements");
  }
  const refinementLimit = raw.maxProvisionalRefinements === undefined
    ? raw.maxExploreRefinements === undefined ? DEFAULTS.maxProvisionalRefinements : raw.maxExploreRefinements
    : raw.maxProvisionalRefinements;

  return Object.freeze({
    template,
    dateFormat,
    timezone,
    language,
    cjkSpacing,
    topicMinChars,
    topicMaxChars,
    fallbackType,
    types: Object.freeze(normalizedTypes.map((entry) => Object.freeze(entry))),
    provider: raw.provider === undefined ? undefined : requireString(raw.provider, "provider"),
    model: raw.model === undefined ? undefined : requireString(raw.model, "model"),
    maxInputBytes: requireInteger(raw.maxInputBytes === undefined ? DEFAULTS.maxInputBytes : raw.maxInputBytes, "maxInputBytes", 256, 1048576),
    maxOutputTokens: requireInteger(raw.maxOutputTokens === undefined ? DEFAULTS.maxOutputTokens : raw.maxOutputTokens, "maxOutputTokens", 8, 4096),
    timeoutMs: requireInteger(raw.timeoutMs === undefined ? DEFAULTS.timeoutMs : raw.timeoutMs, "timeoutMs", 1000, 600000),
    maxProvisionalRefinements: requireInteger(refinementLimit, "maxProvisionalRefinements", 1, 100),
    agentsInstructions: Object.freeze({
      enabled: agentsInstructionsEnabled,
      maxBytes: agentsInstructionsMaxBytes,
    }),
    backfill: Object.freeze({
      enabled: backfillEnabled,
      ...(backfillRoute === undefined ? {} : { fallbackRoute: backfillRoute }),
      retitle: Object.freeze(retitleEntries.map((entry) => Object.freeze(entry))),
    }),
  });
}
