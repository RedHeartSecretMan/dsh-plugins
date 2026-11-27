/**
 * Settings surface: complete form projection, pure merge/validation for the
 * sidebar settings dialog, and full YAML read/write helpers for the plugin
 * detail page's developer editor.
 *
 * Every mutation passes through `resolveConfig` before reaching `configEditor`,
 * so neither surface can persist a configuration the plugin would refuse to
 * start with. Sibling fields not edited by the form (such as `backfill.retitle`)
 * are preserved verbatim on form updates and remain directly editable in YAML.
 *
 * @module session-title-template/settings
 */

import { isDeepStrictEqual } from 'node:util';
import { DEFAULTS, NAMING_PRESETS, resolveConfig } from './config.js';
import { formatConfigYaml, parseConfigYaml } from './yaml.js';

/** Canonical key order matching `DEFAULTS`. */
const CONFIG_KEY_ORDER = Object.keys(DEFAULTS);

/** Editable form field names with their expected wire value kind. */
export const SETTINGS_FIELDS = Object.freeze({
  template: 'string',
  language: 'string',
  uiLanguage: 'string',
  timezone: 'string',
  dateFormat: 'string',
  cjkSpacing: 'boolean',
  topicMinChars: 'number',
  topicMaxChars: 'number',
  fallbackType: 'string',
  fallbackTruncation: 'string',
  types: 'types',
  maxProvisionalRefinements: 'number',
  provider: 'string',
  model: 'string',
  subagentProvider: 'string',
  subagentModel: 'string',
  subagentDelegationLabel: 'boolean',
  fallbackProvider: 'string',
  fallbackModel: 'string',
  roleProbe: 'boolean',
  agentsInstructions: 'boolean',
  agentsInstructionsMaxBytes: 'number',
  backfill: 'boolean',
  maxInputBytes: 'number',
  maxOutputTokens: 'number',
  timeoutMs: 'number',
  retryAttempts: 'number',
  retryDelayMs: 'number',
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejected(message) {
  const error = new Error(`session-title-template: ${message}`);
  error.code = 'invalid-settings';
  return error;
}

/** Normalize a type entry for comparison and clean YAML storage. */
function normalizeRawTypeEntry(entry, index) {
  if (!isPlainObject(entry)) {
    throw rejected(`config.types[${index}] must be an object with key and hint`);
  }
  if (typeof entry.key !== 'string') {
    throw rejected(`config.types[${index}].key must be a string`);
  }
  if (entry.hint !== undefined && typeof entry.hint !== 'string') {
    throw rejected(`config.types[${index}].hint must be a string`);
  }
  if (entry.provisional !== undefined && typeof entry.provisional !== 'boolean') {
    throw rejected(`config.types[${index}].provisional must be a boolean`);
  }
  if (entry.maxRefinements !== undefined) {
    if (entry.provisional !== true) {
      throw rejected(`config.types[${index}].maxRefinements requires provisional: true`);
    }
    if (!Number.isInteger(entry.maxRefinements)) {
      throw rejected(`config.types[${index}].maxRefinements must be an integer`);
    }
  }
  return {
    key: entry.key,
    hint: entry.hint ?? '',
    ...(entry.provisional === true ? { provisional: true } : {}),
    ...(entry.provisional === true && entry.maxRefinements !== undefined
      ? { maxRefinements: entry.maxRefinements }
      : {}),
  };
}

/** Project any type list into form shape (explicit boolean `provisional` and resolved refinement limit). */
function formTypeEntries(entries, defaultLimit = DEFAULTS.maxProvisionalRefinements) {
  return entries.map(entry => ({
    key: entry.key,
    hint: entry.hint,
    provisional: entry.provisional === true,
    ...(entry.provisional === true
      ? { maxRefinements: entry.maxRefinements ?? defaultLimit }
      : {}),
  }));
}

/** Default type list in form shape (explicit boolean `provisional` and resolved refinement limit). */
export function defaultTypeEntries() {
  return formTypeEntries(DEFAULTS.types, DEFAULTS.maxProvisionalRefinements);
}

/** Built-in Chinese and English naming presets in form shape. */
export function namingPresets(defaultLimit = DEFAULTS.maxProvisionalRefinements) {
  return {
    zh: {
      template: NAMING_PRESETS.zh.template,
      language: NAMING_PRESETS.zh.language,
      cjkSpacing: NAMING_PRESETS.zh.cjkSpacing,
      fallbackType: NAMING_PRESETS.zh.fallbackType,
      types: formTypeEntries(NAMING_PRESETS.zh.types, defaultLimit),
    },
    en: {
      template: NAMING_PRESETS.en.template,
      language: NAMING_PRESETS.en.language,
      cjkSpacing: NAMING_PRESETS.en.cjkSpacing,
      fallbackType: NAMING_PRESETS.en.fallbackType,
      types: formTypeEntries(NAMING_PRESETS.en.types, defaultLimit),
    },
  };
}

/**
 * Read the complete form values from a resolved config.
 *
 * @param config - Output of `resolveConfig`.
 * @returns Form values keyed by `SETTINGS_FIELDS`; unset routes use `''`.
 */
export function settingsValues(config) {
  return {
    template: config.template,
    language: config.language,
    uiLanguage: config.uiLanguage,
    timezone: config.timezone,
    dateFormat: config.dateFormat,
    cjkSpacing: config.cjkSpacing,
    topicMinChars: config.topicMinChars,
    topicMaxChars: config.topicMaxChars,
    fallbackType: config.fallbackType,
    fallbackTruncation: config.fallbackTruncation,
    types: formTypeEntries(config.types, config.maxProvisionalRefinements),
    maxProvisionalRefinements: config.maxProvisionalRefinements,
    provider: config.provider ?? '',
    model: config.model ?? '',
    subagentProvider: config.subagentRoute?.provider ?? '',
    subagentModel: config.subagentRoute?.model ?? '',
    subagentDelegationLabel: config.subagentDelegationLabel,
    fallbackProvider: config.fallbackRoute?.provider ?? '',
    fallbackModel: config.fallbackRoute?.model ?? '',
    roleProbe: config.roleProbe.enabled,
    agentsInstructions: config.agentsInstructions.enabled,
    agentsInstructionsMaxBytes: config.agentsInstructions.maxBytes,
    backfill: config.backfill.enabled,
    maxInputBytes: config.maxInputBytes,
    maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
    retryAttempts: config.retryAttempts,
    retryDelayMs: config.retryDelayMs,
  };
}

/**
 * Describe the choices the form offers for closed vocabularies and model selectors.
 *
 * @param config - Output of `resolveConfig`.
 * @param models - Optional discovered provider/model groups from `ctx.llm`.
 * @returns Option lists for language, UI language, presets, types, defaults, and model dropdowns.
 */
export function settingsOptions(config, models = []) {
  return {
    languages: ['zh', 'en'],
    uiLanguages: ['auto', 'zh', 'en'],
    types: config.types.map(type => type.key),
    defaultTypes: defaultTypeEntries(),
    presets: namingPresets(config.maxProvisionalRefinements),
    models,
  };
}

/** Order top-level keys canonically so YAML output stays stable and readable. */
function canonicalRawObject(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const ordered = {};
  for (const key of CONFIG_KEY_ORDER) {
    if (Object.hasOwn(source, key) && source[key] !== undefined) {
      ordered[key] = source[key];
    }
  }
  for (const [key, value] of Object.entries(source)) {
    if (!Object.hasOwn(ordered, key) && value !== undefined) {
      ordered[key] = value;
    }
  }
  return ordered;
}

/**
 * Format the active raw config as clean YAML for the developer editor.
 *
 * @param rawConfig - Active raw config object (from `apply(ctx, rawConfig)`).
 * @returns Canonical YAML text.
 */
export function formatRawConfigYaml(rawConfig) {
  return formatConfigYaml(canonicalRawObject(rawConfig));
}

/**
 * Format a complete resolved config (every configurable field expanded) as YAML,
 * including in-place commented examples for unset optional routes and backfill
 * retitle entries so every valid key is visible without memorizing the schema.
 *
 * @param config - Output of `resolveConfig`.
 * @returns Complete YAML document text.
 */
export function formatFullConfigYaml(config) {
  const beforeRoute = {
    template: config.template,
    dateFormat: config.dateFormat,
    timezone: config.timezone,
    language: config.language,
    uiLanguage: config.uiLanguage,
    cjkSpacing: config.cjkSpacing,
    topicMinChars: config.topicMinChars,
    topicMaxChars: config.topicMaxChars,
    fallbackType: config.fallbackType,
    fallbackTruncation: config.fallbackTruncation,
    types: config.types.map(entry => ({
      key: entry.key,
      hint: entry.hint,
      ...(entry.provisional === true ? { provisional: true } : {}),
      ...(entry.provisional === true && entry.maxRefinements !== undefined
        ? { maxRefinements: entry.maxRefinements }
        : {}),
    })),
    ...(config.provider !== undefined && config.model !== undefined
      ? { provider: config.provider, model: config.model }
      : {}),
    ...(config.subagentRoute !== undefined
      ? {
        subagentRoute: {
          provider: config.subagentRoute.provider,
          model: config.subagentRoute.model,
        },
      }
      : {}),
    ...(config.fallbackRoute !== undefined
      ? {
        fallbackRoute: {
          provider: config.fallbackRoute.provider,
          model: config.fallbackRoute.model,
        },
      }
      : {}),
  };
  const afterRoute = {
    subagentDelegationLabel: config.subagentDelegationLabel,
    maxInputBytes: config.maxInputBytes,
    maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
    retryAttempts: config.retryAttempts,
    retryDelayMs: config.retryDelayMs,
    maxProvisionalRefinements: config.maxProvisionalRefinements,
    roleProbe: { enabled: config.roleProbe.enabled },
    agentsInstructions: {
      enabled: config.agentsInstructions.enabled,
      maxBytes: config.agentsInstructions.maxBytes,
    },
    backfill: {
      enabled: config.backfill.enabled,
      ...(config.backfill.retitle.length > 0
        ? {
          retitle: config.backfill.retitle.map(entry => ({
            id: entry.id,
            ...(entry.hint ? { hint: entry.hint } : {}),
          })),
        }
        : {}),
    },
  };
  const parts = [formatConfigYaml(beforeRoute).trimEnd()];
  if (config.provider === undefined && config.model === undefined) {
    parts.push('# provider: <provider-id>\n# model: <model-id>');
  }
  if (config.subagentRoute === undefined) {
    parts.push('# subagentRoute:\n#   provider: <provider-id>\n#   model: <model-id>');
  }
  if (config.fallbackRoute === undefined) {
    parts.push('# fallbackRoute:\n#   provider: <provider-id>\n#   model: <model-id>');
  }
  parts.push(formatConfigYaml(afterRoute).trimEnd());
  if (config.backfill.retitle.length === 0) {
    parts.push('  # retitle:\n  #   - id: <session-id>\n  #     hint: <optional-hint>');
  }
  return `${parts.join('\n')}\n`;
}

/**
 * Merge a form change set into a complete raw config and validate the result.
 *
 * @param raw - Current raw config of the plugin row (never mutated).
 * @param changes - `{ field: value }` map restricted to `SETTINGS_FIELDS`.
 * @returns The next raw config, safe to hand to `configEditor.edit()`.
 * @throws An error coded `invalid-settings` when a field is unknown, mistyped or
 * rejected by `resolveConfig`.
 */
export function applySettings(raw, changes) {
  if (!isPlainObject(changes)) {
    throw rejected('changes must be an object');
  }
  const keys = Object.keys(changes);
  if (keys.length === 0) throw rejected('changes must name at least one field');

  const next = structuredClone(isPlainObject(raw) ? raw : {});

  for (const key of keys) {
    const kind = SETTINGS_FIELDS[key];
    if (kind === undefined) throw rejected(`${key} is not an editable setting`);
    const value = changes[key];

    if (kind === 'types') {
      // Handled after scalar fields so `maxProvisionalRefinements` is settled first.
      continue;
    }

    if (typeof value !== kind || (kind === 'number' && !Number.isInteger(value))) {
      throw rejected(`${key} must be ${kind === 'number' ? 'an integer' : `a ${kind}`}`);
    }

    if (key === 'roleProbe') {
      const current = isPlainObject(next.roleProbe) ? next.roleProbe : {};
      next.roleProbe = { ...current, enabled: value };
    } else if (key === 'agentsInstructions') {
      const current = isPlainObject(next.agentsInstructions) ? next.agentsInstructions : {};
      next.agentsInstructions = { ...current, enabled: value };
    } else if (key === 'agentsInstructionsMaxBytes') {
      const current = isPlainObject(next.agentsInstructions) ? next.agentsInstructions : {};
      next.agentsInstructions = { ...current, maxBytes: value };
    } else if (key === 'backfill') {
      const current = isPlainObject(next.backfill) ? next.backfill : {};
      next.backfill = { ...current, enabled: value };
    } else if (key === 'subagentProvider' || key === 'subagentModel' || key === 'fallbackProvider' || key === 'fallbackModel') {
      // Handled as pairs after the loop so both halves stay consistent.
    } else if ((key === 'provider' || key === 'model') && value.trim() === '') {
      Reflect.deleteProperty(next, key);
    } else {
      next[key] = typeof value === 'string' ? value.trim() : value;
    }
  }

  if ('types' in changes) {
    const value = changes.types;
    if (!Array.isArray(value)) throw rejected('types must be an array');
    const normalized = value.map(normalizeRawTypeEntry);
    const effectiveDefault = Number.isInteger(next.maxProvisionalRefinements)
      ? next.maxProvisionalRefinements
      : DEFAULTS.maxProvisionalRefinements;
    const strippedComparison = normalized.map(entry => ({
      key: entry.key.trim(),
      hint: entry.hint,
      ...(entry.provisional === true ? { provisional: true } : {}),
    }));
    const provisionalLimits = normalized
      .filter(entry => entry.provisional === true)
      .map(entry => entry.maxRefinements ?? effectiveDefault);
    const uniformLimit = provisionalLimits.length > 0
      && provisionalLimits.every(limit => limit === provisionalLimits[0])
      ? provisionalLimits[0]
      : undefined;
    if (isDeepStrictEqual(strippedComparison, DEFAULTS.types)
      && uniformLimit !== undefined
      && (!('maxProvisionalRefinements' in changes) || uniformLimit === effectiveDefault)) {
      Reflect.deleteProperty(next, 'types');
      if (!('maxProvisionalRefinements' in changes)) {
        if (uniformLimit === DEFAULTS.maxProvisionalRefinements
          && !Object.hasOwn(isPlainObject(raw) ? raw : {}, 'maxProvisionalRefinements')) {
          Reflect.deleteProperty(next, 'maxProvisionalRefinements');
        } else {
          next.maxProvisionalRefinements = uniformLimit;
        }
      }
    } else {
      next.types = normalized.map(entry => {
        const out = { key: entry.key, hint: entry.hint };
        if (entry.provisional === true) {
          out.provisional = true;
          if (entry.maxRefinements !== undefined && entry.maxRefinements !== effectiveDefault) {
            out.maxRefinements = entry.maxRefinements;
          }
        }
        return out;
      });
    }
  }

  applyRoutePair(changes, next, {
    providerKey: 'subagentProvider', modelKey: 'subagentModel', routeKey: 'subagentRoute', field: 'subagentRoute',
  });
  applyRoutePair(changes, next, {
    providerKey: 'fallbackProvider', modelKey: 'fallbackModel', routeKey: 'fallbackRoute', field: 'fallbackRoute',
  });

  try {
    resolveConfig(next);
  } catch (error) {
    throw rejected(String(error?.message ?? error).replace(/^session-title-template:\s*/u, ''));
  }
  return next;
}

/**
 * Merge one provider/model pair from the form into its route object.
 *
 * Both routes follow the same rule: two empty halves remove the route, one
 * empty half is refused, and any other combination replaces the pair while the
 * rest of the raw config stays untouched.
 *
 * @param changes - The form change set (never mutated).
 * @param next - Raw config being built.
 * @param keys - The form field names and the raw route they write.
 * @param keys.providerKey - Form field carrying the provider.
 * @param keys.modelKey - Form field carrying the model.
 * @param keys.routeKey - Raw config key holding `{ provider, model }`.
 * @param keys.field - Config field named in a validation message.
 */
function applyRoutePair(changes, next, { providerKey, modelKey, routeKey, field }) {
  if (!(providerKey in changes) && !(modelKey in changes)) return;
  const current = isPlainObject(next[routeKey]) ? next[routeKey] : {};
  const provider = (providerKey in changes ? changes[providerKey] : String(current.provider ?? '')).trim();
  const model = (modelKey in changes ? changes[modelKey] : String(current.model ?? '')).trim();
  if (provider === '' && model === '') {
    Reflect.deleteProperty(next, routeKey);
    return;
  }
  if (provider === '' || model === '') {
    throw rejected(`config.${field}.provider and model must be supplied together`);
  }
  next[routeKey] = { provider, model };
}

/**
 * Parse and validate a full YAML configuration document for the developer editor.
 *
 * @param yamlText - Raw YAML document representing this plugin's `config` mapping.
 * @returns Validated plain config object ready for `configEditor.edit()`.
 * @throws Error coded `invalid-yaml` on syntax errors or `invalid-settings` on schema errors.
 */
export function applyYamlConfig(yamlText) {
  if (typeof yamlText !== 'string') {
    throw rejected('yaml must be a string');
  }
  const parsed = parseConfigYaml(yamlText);
  if (!isPlainObject(parsed)) {
    throw rejected('YAML root must be a key-value mapping');
  }
  try {
    resolveConfig(parsed);
  } catch (error) {
    throw rejected(String(error?.message ?? error).replace(/^session-title-template:\s*/u, ''));
  }
  return parsed;
}
