import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, it } from "node:test";

import { createStateStore, stateDirectory } from "../lib/state.js";

const stateModule = new URL("../lib/state.js", import.meta.url);
const LOG_LIMIT_BYTES = 512 * 1024;

/** Every filesystem test owns and removes a separate temporary root. */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "session-title-agents-state-"));
  const store = createStateStore({ directory });
  t.after(async () => {
    await store.idle();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store };
}

/** Children have no piped output and never inherit a real state location. */
function childWriter(directory, prefix) {
  const source = `
    import { createStateStore } from ${JSON.stringify(stateModule.href)};
    const store = createStateStore({ directory: ${JSON.stringify(directory)} });
    for (let index = 0; index < 16; index += 1) {
      await store.markBackfilled(${JSON.stringify(prefix)} + index);
      await store.markRetitled(${JSON.stringify(prefix)} + index, "fixture hint");
    }
    await store.idle();
  `;
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      env: { ...process.env, DSH_HOME: directory, DSH_PROFILE_DIR: directory, DSH_PROFILE: "fixture" },
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) done();
      else reject(new Error(`State fixture child failed (code ${code}, signal ${signal})`));
    });
  });
}

describe("stateDirectory", () => {
  it("prefers an absolute profile directory over home and profile name", () => {
    const root = resolve("state-fixture-home");
    assert.equal(stateDirectory({ DSH_HOME: join(root, "home"), DSH_PROFILE: "other", DSH_PROFILE_DIR: join(root, "profile", "..", "selected") }),
      join(root, "selected", "state", "session-title-agents"));
  });

  it("scopes named profiles and keeps the unprofiled legacy location", () => {
    const home = resolve("state-fixture-home");
    assert.equal(stateDirectory({ DSH_HOME: home, DSH_PROFILE: "primary" }), join(home, "profiles", "primary", "state", "session-title-agents"));
    assert.equal(stateDirectory({ DSH_HOME: home, DSH_PROFILE: "secondary" }), join(home, "profiles", "secondary", "state", "session-title-agents"));
    assert.equal(stateDirectory({ DSH_HOME: home }), join(home, "session-title-agents"));
  });

  it("ignores relative profile directories and normalizes relative homes", () => {
    assert.equal(stateDirectory({ DSH_HOME: "fixture-home/../fixture-selected", DSH_PROFILE: "named", DSH_PROFILE_DIR: "relative-profile" }),
      join(resolve("fixture-selected"), "profiles", "named", "state", "session-title-agents"));
    assert.equal(isAbsolute(stateDirectory({ DSH_HOME: "." })), true);
  });

  it("expands home prefixes and uses node:os when home is not configured", () => {
    assert.equal(stateDirectory({ DSH_HOME: "~/.dsh-fixture/../selected" }), join(homedir(), "selected", "session-title-agents"));
    assert.equal(stateDirectory({ DSH_PROFILE_DIR: "~/profile-fixture" }), join(homedir(), "profile-fixture", "state", "session-title-agents"));
    assert.equal(stateDirectory({}), join(homedir(), ".dsh", "session-title-agents"));
  });

  it("rejects profile traversal instead of merging profile state", () => {
    for (const profile of ["..", ".", "../other", "x/y", "x\\y", "x:y"]) {
      assert.throws(() => stateDirectory({ DSH_HOME: resolve("fixture-home"), DSH_PROFILE: profile }), /safe profile name/u);
    }
  });
});

describe("state persistence", () => {
  it("starts empty only for a missing file and preserves the legacy shape", async (t) => {
    const { store } = await fixture(t);
    const empty = await store.read();
    assert.deepEqual(empty.backfilled, []);
    assert.deepEqual(Object.keys(empty.retitled), []);
    await store.markBackfilled("session-a");
    await store.markBackfilled("session-a");
    await store.markRetitled("session-b", "fixture hint");
    assert.deepEqual(JSON.parse(await readFile(store.stateFile, "utf8")), {
      backfilled: ["session-a"], retitled: { "session-b": "fixture hint" },
    });
  });

  it("reads valid legacy state before applying updates", async (t) => {
    const { store } = await fixture(t);
    await writeFile(store.stateFile, JSON.stringify({ backfilled: ["legacy"], retitled: { old: "old hint" } }));
    await store.markBackfilled("new");
    await store.markRetitled("fresh");
    const current = await store.read();
    assert.deepEqual(current.backfilled, ["legacy", "new"]);
    assert.equal(current.retitled.old, "old hint");
    assert.equal(current.retitled.fresh, "");
  });

  it("retains every simultaneous update from two normalized store paths", async (t) => {
    const { directory, store } = await fixture(t);
    const other = createStateStore({ directory: join(directory, "unused", "..") });
    const operations = [];
    for (let index = 0; index < 30; index += 1) {
      operations.push(store.markBackfilled(`a-${index}`), other.markBackfilled(`b-${index}`));
      operations.push(store.markRetitled(`a-${index}`, "a"), other.markRetitled(`b-${index}`, "b"));
    }
    await Promise.all(operations);
    const state = await store.read();
    assert.equal(state.backfilled.length, 60);
    assert.equal(new Set(state.backfilled).size, 60);
    assert.equal(Object.keys(state.retitled).length, 60);
    await other.idle();
    assert.deepEqual((await readdir(directory)).sort(), ["backfill-state.json"]);
  });

  it("shares queues across separate activation module URLs", async (t) => {
    const { directory, store } = await fixture(t);
    const activation = await import(`${stateModule.href}?state-fixture-activation`);
    const other = activation.createStateStore({ directory });
    await Promise.all([store.markBackfilled("first"), other.markBackfilled("second")]);
    assert.deepEqual((await other.read()).backfilled, ["first", "second"]);
    await other.idle();
  });

  it("serializes independent process read-modify-write operations", async (t) => {
    const { directory, store } = await fixture(t);
    await Promise.all([childWriter(directory, "child-a-"), childWriter(directory, "child-b-")]);
    const state = await store.read();
    assert.equal(state.backfilled.length, 32);
    assert.equal(Object.keys(state.retitled).length, 32);
    for (let index = 0; index < 16; index += 1) {
      assert.equal(state.backfilled.includes(`child-a-${index}`), true);
      assert.equal(state.backfilled.includes(`child-b-${index}`), true);
    }
  });

  it("does not poison later writes when one operation rejects", async (t) => {
    const { store } = await fixture(t);
    const failed = store.markBackfilled(42);
    const following = store.markBackfilled("valid");
    await assert.rejects(failed, /nonempty session id/u);
    await following;
    await assert.rejects(store.markRetitled("valid", 42), /hint must be a string/u);
    await store.markRetitled("valid", "recovered");
    assert.deepEqual((await store.read()).backfilled, ["valid"]);
    assert.equal((await store.read()).retitled.valid, "recovered");
    await store.idle();
  });

  it("keeps malformed JSON intact and surfaces a content-free error", async (t) => {
    const { directory, store } = await fixture(t);
    const corrupt = '{"backfilled": ["private-fixture-content"';
    await writeFile(store.stateFile, corrupt);
    const invalid = (error) => error.code === "STATE_INVALID" && !error.message.includes("private-fixture-content");
    await assert.rejects(store.read(), invalid);
    await assert.rejects(store.markBackfilled("new"), invalid);
    await store.idle();
    assert.equal(await readFile(store.stateFile, "utf8"), corrupt);
    assert.deepEqual(await readdir(directory), ["backfill-state.json"]);
    await writeFile(store.stateFile, '{"backfilled":[],"retitled":{}}');
    await store.markBackfilled("recovered");
    assert.deepEqual((await store.read()).backfilled, ["recovered"]);
  });

  it("rejects invalid schemas without rewriting any input", async (t) => {
    const { store } = await fixture(t);
    const invalid = [null, [], {}, { backfilled: [], retitled: {}, future: true },
      { backfilled: [42], retitled: {} }, { backfilled: [""], retitled: {} },
      { backfilled: [], retitled: [] }, { backfilled: [], retitled: { id: false } }];
    for (const state of invalid) {
      const content = JSON.stringify(state);
      await writeFile(store.stateFile, content);
      await assert.rejects(store.read(), { code: "STATE_INVALID" });
      await assert.rejects(store.markBackfilled("new"), { code: "STATE_INVALID" });
      assert.equal(await readFile(store.stateFile, "utf8"), content);
    }
  });

  it("surfaces non-ENOENT read failures without replacing the state path", async (t) => {
    const { store } = await fixture(t);
    await mkdir(store.stateFile);
    await assert.rejects(store.read(), (error) => error.code !== "ENOENT");
    await assert.rejects(store.markBackfilled("new"), (error) => error.code !== "ENOENT");
    assert.equal((await stat(store.stateFile)).isDirectory(), true);
  });

  it("stores special property names without inheriting or mutating prototypes", async (t) => {
    const { store } = await fixture(t);
    assert.equal((await store.read()).retitled.toString, undefined);
    await store.markRetitled("__proto__", "proto hint");
    await store.markRetitled("constructor", "constructor hint");
    await store.markRetitled("toString", "method hint");
    const state = await store.read();
    assert.equal(Object.getPrototypeOf(state.retitled), null);
    assert.equal(state.retitled.__proto__, "proto hint");
    assert.equal(state.retitled.constructor, "constructor hint");
    assert.equal(state.retitled.toString, "method hint");
    assert.equal({}.polluted, undefined);
  });

  it("read observes previously queued writes and idle drains ignored writes", async (t) => {
    const { store } = await fixture(t);
    void store.markBackfilled("queued");
    assert.deepEqual((await store.read()).backfilled, ["queued"]);
    void store.markBackfilled("idle");
    await store.idle();
    assert.deepEqual(JSON.parse(await readFile(store.stateFile, "utf8")).backfilled, ["queued", "idle"]);
  });
});

describe("file locks", () => {
  it("honors cancellation without stealing a lock or poisoning the queue", async (t) => {
    const { store } = await fixture(t);
    const lock = `${store.stateFile}.lock`;
    await writeFile(lock, "fixture-owner");
    await assert.rejects(store.markBackfilled("cancelled", { signal: AbortSignal.timeout(50) }), { name: "AbortError" });
    assert.equal(await readFile(lock, "utf8"), "fixture-owner");
    await rm(lock);
    await store.markBackfilled("after-cancel");
    assert.deepEqual((await store.read()).backfilled, ["after-cancel"]);
  });

  it("bounds lock waits and never steals even an apparently stale lock", { timeout: 8_000 }, async (t) => {
    const { store } = await fixture(t);
    const lock = `${store.stateFile}.lock`;
    const owner = JSON.stringify({ pid: 2147483647, token: "fixture-stale" });
    await writeFile(lock, owner);
    await assert.rejects(store.markBackfilled("blocked"), { code: "STATE_LOCK_TIMEOUT" });
    assert.equal(await readFile(lock, "utf8"), owner);
    await rm(lock);
    await store.markBackfilled("after-timeout");
    assert.deepEqual((await store.read()).backfilled, ["after-timeout"]);
  });

  it("does not create files for an already aborted operation", async (t) => {
    const { directory, store } = await fixture(t);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(store.markBackfilled("cancelled", { signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(store.read({ signal: controller.signal }), { name: "AbortError" });
    await store.idle();
    assert.deepEqual(await readdir(directory), []);
  });
});

describe("diagnostic logs", () => {
  it("drains fire-and-forget notes and forwards events to the provided logger", async (t) => {
    const { directory, store } = await fixture(t);
    const messages = [];
    const logging = createStateStore({ directory, log: (message) => messages.push(message) });
    logging.note("fixture event one");
    store.note("fixture event two");
    await logging.idle();
    const content = await readFile(store.logFile, "utf8");
    assert.match(content, /fixture event one/u);
    assert.match(content, /fixture event two/u);
    assert.deepEqual(messages, ["fixture event one"]);
  });

  it("bounds each entry and keeps only one bounded rotated backup", async (t) => {
    const { directory, store } = await fixture(t);
    await writeFile(store.logFile, "x".repeat(LOG_LIMIT_BYTES - 5));
    await store.append("rotation event");
    assert.equal((await stat(`${store.logFile}.1`)).size, LOG_LIMIT_BYTES - 5);
    await store.append("x".repeat(LOG_LIMIT_BYTES * 2));
    assert.equal((await stat(store.logFile)).size < LOG_LIMIT_BYTES, true);
    assert.match(await readFile(store.logFile, "utf8"), /\[truncated\]/u);
    await writeFile(store.logFile, "y".repeat(LOG_LIMIT_BYTES));
    await store.append("second rotation event");
    assert.equal((await stat(`${store.logFile}.1`)).size, LOG_LIMIT_BYTES);
    assert.deepEqual((await readdir(directory)).sort(), ["backfill.log", "backfill.log.1"]);
  });

  it("bounds a legacy oversized log during its first rotation", async (t) => {
    const { store } = await fixture(t);
    await writeFile(store.logFile, "x".repeat(LOG_LIMIT_BYTES * 2));
    await store.append("migration event");
    assert.equal((await stat(`${store.logFile}.1`)).size, LOG_LIMIT_BYTES);
    assert.equal((await stat(store.logFile)).size < LOG_LIMIT_BYTES, true);
  });

  it("keeps log failure best effort and recovers on later appends", async (t) => {
    const { directory, store } = await fixture(t);
    const messages = [];
    const logging = createStateStore({ directory, log: (message) => messages.push(message) });
    await mkdir(store.logFile);
    await logging.append("fixture event");
    logging.note("fixture note");
    await logging.idle();
    assert.equal(messages.includes("session-title-agents: diagnostic log write failed"), true);
    await store.markBackfilled("state-still-correct");
    await rm(store.logFile, { recursive: true });
    await logging.append("recovered event");
    assert.match(await readFile(store.logFile, "utf8"), /recovered event/u);
    assert.deepEqual((await store.read()).backfilled, ["state-still-correct"]);
  });

  it("does not let logger exceptions or a held log lock prevent state writes", async (t) => {
    const { directory, store } = await fixture(t);
    const logging = createStateStore({ directory, log: async () => { throw new Error("fixture logger failure"); } });
    const lock = `${store.logFile}.lock`;
    await writeFile(lock, "fixture-log-owner");
    await logging.append("fixture event");
    await logging.markBackfilled("kept");
    assert.deepEqual((await logging.read()).backfilled, ["kept"]);
    assert.equal(await readFile(lock, "utf8"), "fixture-log-owner");
    await rm(lock);
    logging.note("logger still throws");
    await logging.idle();
    assert.match(await readFile(store.logFile, "utf8"), /logger still throws/u);
  });
});
