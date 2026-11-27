/**
 * Detect whether this process runs older Host modules than the ones on disk.
 *
 * A profile-installed plugin's Client half is served over HTTP and reloads on
 * every bundle change, but its Host half is ESM loaded once when the plugin
 * activates. After an edit the two halves therefore disagree until DSH restarts,
 * and the only visible symptom is "my change did nothing". Comparing the process
 * start time with the modules' newest mtime turns that silence into a fact the
 * settings form can state.
 *
 * @module session-title-template/build-info
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package root of this module (one level above `lib/`). */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Files that make up the Host half; `client.js` reloads on its own. */
const HOST_ENTRY = 'index.js';
const HOST_LIB_DIR = 'lib';

/**
 * Wall-clock instant this process started, from its own uptime.
 *
 * @param now - Current epoch milliseconds.
 * @param uptimeSeconds - `process.uptime()` at the same moment.
 * @returns The epoch milliseconds of process start.
 */
export function processStartedAt(now, uptimeSeconds) {
  return Math.round(now - uptimeSeconds * 1000);
}

/**
 * Report whether any module is newer than the running process.
 *
 * A one-second grace absorbs filesystem timestamp granularity, so a plugin that
 * was just written and immediately loaded does not report itself stale.
 *
 * @param startedAt - Epoch milliseconds of process start.
 * @param mtimes - Module paths and their modification times.
 * @returns The newest module path that postdates the process, or undefined when
 * the running code is current.
 */
export function staleModule(startedAt, mtimes) {
  let newest;
  for (const [path, mtimeMs] of Object.entries(mtimes)) {
    if (!Number.isFinite(mtimeMs) || mtimeMs <= startedAt + 1000) continue;
    if (newest === undefined || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
  }
  return newest?.path;
}

/**
 * Read the modification times of this package's Host modules.
 *
 * An unreadable file is skipped: the check reports a diagnostic convenience and
 * must never be the reason a plugin fails to activate.
 *
 * @param root - Package root; defaults to this module's own package.
 * @returns A `{ path: mtimeMs }` map keyed by package-relative path.
 */
export function hostModuleMtimes(root = PACKAGE_ROOT) {
  const mtimes = {};
  const record = (relative) => {
    try {
      mtimes[relative] = statSync(join(root, relative)).mtimeMs;
    } catch {
      // A module this process did not load is not evidence of staleness.
    }
  };
  record(HOST_ENTRY);
  let entries = [];
  try {
    entries = readdirSync(join(root, HOST_LIB_DIR), { withFileTypes: true });
  } catch {
    return mtimes;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    record(`${HOST_LIB_DIR}/${entry.name}`);
  }
  // Nested modules such as lib/title/*.js are part of the Host half too.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let nested = [];
    try {
      nested = readdirSync(join(root, HOST_LIB_DIR, entry.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of nested) {
      if (!child.isFile() || !child.name.endsWith('.js')) continue;
      record(`${HOST_LIB_DIR}/${entry.name}/${child.name}`);
    }
  }
  return mtimes;
}

/**
 * Report whether the running Host half predates the files on disk.
 *
 * @param options - Optional process facts and package root, for tests.
 * @returns The stale module's path, or undefined when the running code is current.
 */
export function hostStaleness({ startedAt, root, mtimes } = {}) {
  const start = startedAt ?? processStartedAt(Date.now(), process.uptime());
  const map = mtimes ?? hostModuleMtimes(root);
  return staleModule(start, map);
}
