/**
 * Configuration defaults and validation. Kept independent of Harness imports
 * so invalid profile values fail clearly at activation without dependencies.
 * @module session-video-intake/config
 */
import { existsSync } from 'node:fs';
import { STORYBOARD_DEFAULTS } from './defaults.js';

const MIB = 1024 * 1024;

/** Canonical public configuration keys and their defaults. */
export const DEFAULTS = {
  enabled: true,
  /**
   * `undefined` means "no explicit whitelist": native video is then decided by
   * the catalog probe. An array (including `[]`) is authoritative and disables
   * probing.
   */
  videoRoutes: undefined,
  catalogProbe: {
    enabled: true,
    timeoutMs: 2500,
    ttlMs: 300000,
  },
  maxOutputTokens: 32768,
  maxVideoBytes: 64 * MIB,
  maxTotalVideoBytes: 64 * MIB,
  maxVideos: 8,
  storyboard: {
    enabled: true,
    sceneAware: true,
    ...STORYBOARD_DEFAULTS,
  },
};

function invalid(field, expectation) {
  throw new Error(`session-video-intake: config.${field} ${expectation}`);
}

function rejectUnknown(record, keys, field = '') {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) invalid(field ? `${field}.${key}` : key, 'is an unknown key');
  }
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') invalid(field, 'must be a boolean');
  return value;
}

function requireInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    invalid(field, `must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function optionalPath(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) invalid(field, 'must be a non-empty path string');
  return value.trim();
}

function normalizeRoutes(value) {
  if (!Array.isArray(value)) invalid('videoRoutes', 'must be an array of "provider/model" strings');
  const routes = [];
  for (const [index, entry] of value.entries()) {
    const field = `videoRoutes[${index}]`;
    if (typeof entry !== 'string') invalid(field, 'must be a "provider/model" string');
    const route = entry.trim();
    // Split on the first slash only: model ids may themselves contain slashes
    // (for example `magpie/auto/deepseek-flash`).
    const slash = route.indexOf('/');
    const provider = route.slice(0, slash);
    const model = route.slice(slash + 1);
    if (slash <= 0 || provider.length === 0 || model.length === 0) invalid(field, 'must be "provider/model"');
    if (model.startsWith('/') || model.endsWith('/')) invalid(field, 'must name a non-empty provider and model');
    if (routes.includes(route)) invalid(field, 'duplicates an earlier route');
    routes.push(route);
  }
  return routes;
}

function normalizeCatalogProbe(value) {
  const probe = value ?? {};
  if (typeof probe !== 'object' || probe === null || Array.isArray(probe)) {
    invalid('catalogProbe', 'must be an object');
  }
  rejectUnknown(probe, ['enabled', 'timeoutMs', 'ttlMs'], 'catalogProbe');
  return Object.freeze({
    enabled: probe.enabled === undefined ? DEFAULTS.catalogProbe.enabled : requireBoolean(probe.enabled, 'catalogProbe.enabled'),
    timeoutMs: probe.timeoutMs === undefined ? DEFAULTS.catalogProbe.timeoutMs : requireInteger(probe.timeoutMs, 'catalogProbe.timeoutMs', 200, 10000),
    ttlMs: probe.ttlMs === undefined ? DEFAULTS.catalogProbe.ttlMs : requireInteger(probe.ttlMs, 'catalogProbe.ttlMs', 10000, 3600000),
  });
}

function normalizeStoryboard(value) {
  const storyboard = value ?? {};
  if (typeof storyboard !== 'object' || storyboard === null || Array.isArray(storyboard)) {
    invalid('storyboard', 'must be an object');
  }
  rejectUnknown(storyboard, ['enabled', 'sceneAware', 'cells', 'cellEdge', 'timeoutMs', 'ffmpegPath', 'ffprobePath'], 'storyboard');
  return Object.freeze({
    enabled: storyboard.enabled === undefined ? DEFAULTS.storyboard.enabled : requireBoolean(storyboard.enabled, 'storyboard.enabled'),
    sceneAware: storyboard.sceneAware === undefined ? DEFAULTS.storyboard.sceneAware : requireBoolean(storyboard.sceneAware, 'storyboard.sceneAware'),
    cells: storyboard.cells === undefined ? DEFAULTS.storyboard.cells : requireInteger(storyboard.cells, 'storyboard.cells', 4, 16),
    cellEdge: storyboard.cellEdge === undefined ? DEFAULTS.storyboard.cellEdge : requireInteger(storyboard.cellEdge, 'storyboard.cellEdge', 64, 1024),
    timeoutMs: storyboard.timeoutMs === undefined ? DEFAULTS.storyboard.timeoutMs : requireInteger(storyboard.timeoutMs, 'storyboard.timeoutMs', 1000, 600000),
    ffmpegPath: optionalPath(storyboard.ffmpegPath, 'storyboard.ffmpegPath'),
    ffprobePath: optionalPath(storyboard.ffprobePath, 'storyboard.ffprobePath'),
  });
}

/**
 * Validate one profile configuration object and materialize defaults.
 * @param {object} [rawConfig] the `config` block from the profile patch.
 * @returns {Readonly<object>} frozen settings; unknown keys are activation errors.
 */
export function resolveConfig(rawConfig) {
  const raw = rawConfig ?? {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalid('', 'must be an object');
  }
  rejectUnknown(raw, Object.keys(DEFAULTS));
  const config = {
    enabled: raw.enabled === undefined ? DEFAULTS.enabled : requireBoolean(raw.enabled, 'enabled'),
    videoRoutes: raw.videoRoutes === undefined ? undefined : Object.freeze(normalizeRoutes(raw.videoRoutes)),
    catalogProbe: normalizeCatalogProbe(raw.catalogProbe),
    maxOutputTokens: raw.maxOutputTokens === undefined ? DEFAULTS.maxOutputTokens : requireInteger(raw.maxOutputTokens, 'maxOutputTokens', 1, 1048576),
    maxVideoBytes: raw.maxVideoBytes === undefined ? DEFAULTS.maxVideoBytes : requireInteger(raw.maxVideoBytes, 'maxVideoBytes', 1, 2147483647),
    maxTotalVideoBytes: raw.maxTotalVideoBytes === undefined ? DEFAULTS.maxTotalVideoBytes : requireInteger(raw.maxTotalVideoBytes, 'maxTotalVideoBytes', 1, 2147483647),
    maxVideos: raw.maxVideos === undefined ? DEFAULTS.maxVideos : requireInteger(raw.maxVideos, 'maxVideos', 1, 64),
    storyboard: normalizeStoryboard(raw.storyboard),
  };
  return Object.freeze(config);
}

function toolPath(configured, envName, fallback) {
  if (configured !== undefined) return configured;
  const fromEnv = process.env[envName];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  return existsSync(fallback) ? fallback : undefined;
}

/**
 * Resolve FFmpeg executables: explicit config, then environment, then Homebrew,
 * then the bare command name so the runner can report a missing binary clearly.
 * @param {Readonly<object>} storyboard the validated storyboard settings.
 * @returns {{ffmpegPath: string, ffprobePath: string}} executable names or paths.
 */
export function resolveToolPaths(storyboard) {
  return {
    ffmpegPath: toolPath(storyboard.ffmpegPath, 'SESSION_VIDEO_FFMPEG', '/opt/homebrew/bin/ffmpeg') ?? 'ffmpeg',
    ffprobePath: toolPath(storyboard.ffprobePath, 'SESSION_VIDEO_FFPROBE', '/opt/homebrew/bin/ffprobe') ?? 'ffprobe',
  };
}
