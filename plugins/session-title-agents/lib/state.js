/**
 * Profile-scoped bookkeeping and bounded diagnostic logs.
 *
 * State lives outside the replaceable plugin package. Atomic replacements and
 * exclusive sidecar locks protect the legacy JSON shape across activations and
 * processes. Locks are never stolen: an abandoned lock requires operator cleanup.
 *
 * @module session-title-agents/state
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Directory name owned by this plugin. */
export const STATE_DIR_NAME = "session-title-agents";

const STATE_LOCK_WAIT_MS = 5_000;
const LOG_LOCK_WAIT_MS = 200;
const LOCK_RETRY_MS = 20;
const LOG_LIMIT_BYTES = 512 * 1024;
const LOG_ENTRY_LIMIT_BYTES = 16 * 1024;

// Symbol.for also shares queues when an activation imports another module URL.
const queueSymbol = Symbol.for("session-title-agents.file-queues");
const queues = globalThis[queueSymbol] ??= new Map();

/** Expand a conventional home prefix and normalize a configured path. */
function configuredPath(value) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const path = value.trim();
  if (path === "~") return homedir();
  if (/^~[/\\]/u.test(path)) return normalize(join(homedir(), path.slice(2)));
  return normalize(path);
}

/**
 * Resolve the plugin directory without reading or creating any state.
 * DSH_PROFILE_DIR must be absolute; a relative value cannot select a profile.
 *
 * @param env - Environment mapping; defaults to the process environment.
 * @returns Absolute, normalized path to the plugin's state directory.
 */
export function stateDirectory(env = process.env) {
  const profileDirectory = configuredPath(env.DSH_PROFILE_DIR);
  if (profileDirectory !== undefined && isAbsolute(profileDirectory)) {
    return join(profileDirectory, "state", STATE_DIR_NAME);
  }

  const home = resolve(configuredPath(env.DSH_HOME) ?? join(homedir(), ".dsh"));
  const profile = typeof env.DSH_PROFILE === "string" ? env.DSH_PROFILE.trim() : "";
  if (profile !== "") {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(profile)) {
      throw new TypeError("DSH_PROFILE must be a safe profile name");
    }
    return join(home, "profiles", profile, "state", STATE_DIR_NAME);
  }
  return join(home, STATE_DIR_NAME);
}

/** Normalize aliases such as relative paths and Windows filename casing. */
function filenameKey(file) {
  const absolute = resolve(file);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** Serialize operations while retaining a fulfilled tail after every failure. */
function enqueue(file, operation) {
  const key = filenameKey(file);
  const result = (queues.get(key) ?? Promise.resolve()).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}

function emptyState() {
  return { backfilled: [], retitled: Object.create(null) };
}

function invalidState(message) {
  const error = new Error(`Invalid session-title-agents state: ${message}`);
  error.code = "STATE_INVALID";
  return error;
}

function validId(id) {
  return typeof id === "string" && id.length > 0;
}

/** Validate rather than coercing or discarding possibly valuable state. */
function validateState(parsed) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    || Object.keys(parsed).length !== 2
    || !Object.hasOwn(parsed, "backfilled") || !Object.hasOwn(parsed, "retitled")
    || !Array.isArray(parsed.backfilled) || !parsed.backfilled.every(validId)
    || typeof parsed.retitled !== "object" || parsed.retitled === null || Array.isArray(parsed.retitled)) {
    throw invalidState("expected backfilled string array and retitled string mapping");
  }

  const retitled = Object.create(null);
  for (const [id, hint] of Object.entries(parsed.retitled)) {
    if (!validId(id) || typeof hint !== "string") throw invalidState("invalid retitled entry");
    retitled[id] = hint;
  }
  return { backfilled: [...parsed.backfilled], retitled };
}

/** Only a missing file represents empty state; all other failures surface. */
async function readStateFile(file, signal) {
  let content;
  try {
    content = await readFile(file, { encoding: "utf8", signal });
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // JSON.parse errors can quote stored hints; do not expose that content.
    throw invalidState("invalid JSON");
  }
  return validateState(parsed);
}

/**
 * Acquire a cross-process lock with a bounded, cancellable wait. There is no
 * time-based lock stealing: a slow owner must never lose its lock to a writer.
 */
async function withLock(file, waitMs, signal, operation) {
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  let handle;
  while (handle === undefined) {
    signal?.throwIfAborted();
    try {
      handle = await open(lockFile, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const timeout = new Error("Timed out waiting for session-title-agents file lock");
        timeout.code = "STATE_LOCK_TIMEOUT";
        throw timeout;
      }
      await delay(Math.min(LOCK_RETRY_MS, remaining), undefined, { signal });
    }
  }

  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }), "utf8");
    signal?.throwIfAborted();
    return await operation();
  } finally {
    try {
      await handle.close();
    } finally {
      await unlink(lockFile);
    }
  }
}

/** Replace a file atomically, removing only this operation's UUID temporary. */
async function writeStateFile(file, state, signal) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600, signal });
    signal?.throwIfAborted();
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

/** Keep one bounded backup, including when migrating an oversized old log. */
async function rotateLog(file, entryBytes) {
  let size;
  try {
    size = (await stat(file)).size;
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (size + entryBytes <= LOG_LIMIT_BYTES) return;

  const backup = `${file}.1`;
  if (size > LOG_LIMIT_BYTES) {
    const source = await open(file, "r");
    try {
      const tail = Buffer.alloc(LOG_LIMIT_BYTES);
      const { bytesRead } = await source.read(tail, 0, tail.length, size - tail.length);
      await writeFile(backup, tail.subarray(0, bytesRead), { mode: 0o600 });
    } finally {
      await source.close();
    }
    await unlink(file);
  } else {
    await rename(file, backup);
  }
}

function logEntry(line) {
  const text = typeof line === "string" ? line.replace(/[\r\n]+/gu, " ") : "invalid diagnostic event";
  const content = Buffer.from(text, "utf8");
  const bounded = content.length > LOG_ENTRY_LIMIT_BYTES
    ? `${content.subarray(0, LOG_ENTRY_LIMIT_BYTES).toString("utf8")} [truncated]`
    : text;
  return `[${new Date().toISOString()}] ${bounded}\n`;
}

/**
 * Open one activation's store. Log callers must pass diagnostic events only,
 * never title/message text or exception messages that may contain such text.
 *
 * @param options - State directory and an optional diagnostic logger.
 * @returns Legacy readers/writers plus idle() for shutdown and isolated tests.
 */
export function createStateStore({ directory, log }) {
  if (typeof directory !== "string" || directory.trim() === "") throw new TypeError("A state directory is required");
  directory = resolve(directory);
  const stateFile = join(directory, "backfill-state.json");
  const logFile = join(directory, "backfill.log");

  async function notify(line) {
    try {
      if (typeof log === "function") await log(line);
    } catch {
      // Diagnostics must never change state/backfill correctness.
    }
  }

  function append(line, { signal } = {}) {
    return enqueue(logFile, async () => {
      const entry = logEntry(line);
      await notify(entry.slice(entry.indexOf("] ") + 2).trimEnd());
      try {
        signal?.throwIfAborted();
        await mkdir(directory, { recursive: true });
        await withLock(logFile, LOG_LOCK_WAIT_MS, signal, async () => {
          await rotateLog(logFile, Buffer.byteLength(entry));
          await appendFile(logFile, entry, { encoding: "utf8", mode: 0o600, signal });
        });
      } catch {
        await notify("session-title-agents: diagnostic log write failed");
      }
    });
  }

  function update(mutate, { signal } = {}) {
    return enqueue(stateFile, async () => {
      signal?.throwIfAborted();
      await mkdir(directory, { recursive: true });
      return withLock(stateFile, STATE_LOCK_WAIT_MS, signal, async () => {
        const current = await readStateFile(stateFile, signal);
        mutate(current);
        signal?.throwIfAborted();
        await writeStateFile(stateFile, current, signal);
        return current;
      });
    });
  }

  return {
    directory,
    stateFile,
    logFile,
    read: ({ signal } = {}) => enqueue(stateFile, async () => {
      signal?.throwIfAborted();
      return readStateFile(stateFile, signal);
    }),
    markBackfilled: (id, options) => update((state) => {
      if (!validId(id)) throw new TypeError("A nonempty session id is required");
      if (!state.backfilled.includes(id)) state.backfilled.push(id);
    }, options),
    markRetitled: (id, hint, options) => update((state) => {
      if (!validId(id)) throw new TypeError("A nonempty session id is required");
      if (hint !== undefined && hint !== null && typeof hint !== "string") throw new TypeError("A retitle hint must be a string");
      state.retitled[id] = hint ?? "";
    }, options),
    /** Best-effort append; failures never reject or poison later log writes. */
    append,
    note(line) {
      void append(line);
    },
    /** Drain shared state/log tails without rethrowing already surfaced errors. */
    async idle() {
      const keys = [filenameKey(stateFile), filenameKey(logFile)];
      for (;;) {
        const pending = keys.map((key) => queues.get(key));
        await Promise.all(pending);
        if (keys.every((key, index) => queues.get(key) === undefined || queues.get(key) === pending[index])) return;
      }
    },
  };
}
