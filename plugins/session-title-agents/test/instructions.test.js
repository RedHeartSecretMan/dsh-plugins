import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { describe, it } from "node:test";

import { createInstructionReader, extractNamingSections } from "../lib/instructions.js";

const start = "<!-- session-title-agents:start -->";
const end = "<!-- session-title-agents:end -->";
const empty = { text: "", sources: [] };
const unavailable = { ...empty, unavailable: true };
const label = source => `Instructions from: ${source}\n\n`;

it('diagnostics expose only failure categories, never exception contents', async t => {
  const f = await fixture(t); const reasons = [];
  const read = createInstructionReader({ discover: async () => { throw new Error('SECRET_MARKER'); }, onDiagnostic: reason => reasons.push(reason) });
  assert.deepEqual(await read({ cwd: f.cwd }), unavailable);
  assert.deepEqual(reasons, ['discovery-failed']);
});
it('diagnostic callback failures cannot break graceful fallback', async t => {
  const f = await fixture(t);
  const read = createInstructionReader({ discover: async () => { throw new Error('bad'); }, onDiagnostic: () => { throw new Error('logger failure'); } });
  assert.deepEqual(await read({ cwd: f.cwd }), unavailable);
});
it('invalid records and unreadable files receive distinct diagnostic categories', async t => {
  const f = await fixture(t); const reasons = [];
  const read = createInstructionReader({ discover: async () => [{ path: 'wrong-field' }, { absolutePath: join(f.cwd, 'missing'), displayPath: 'missing' }], onDiagnostic: reason => reasons.push(reason) });
  assert.deepEqual(await read({ cwd: f.cwd }), unavailable);
  assert.deepEqual(reasons, ['invalid-discovery-record', 'read-failed']);
});

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "session-title-instructions-"));
  assert.ok(isAbsolute(cwd));
  assert.equal(dirname(cwd), resolve(tmpdir()));
  assert.ok(basename(cwd).startsWith("session-title-instructions-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const files = [];
  return {
    cwd,
    files,
    discover: async () => files,
    async add(displayPath, content) {
      const absolutePath = join(cwd, displayPath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
      const file = { absolutePath, displayPath };
      files.push(file);
      return file;
    },
  };
}

describe("extractNamingSections", () => {
  it("retains Chinese naming headings and subsections through the next same or higher heading", () => {
    const first = "# 会话命名原则\n使用简洁标题。\n## 日期\n使用创建时间。\n### 对话标题示例\n保留示例。";
    const second = "## 对话标题\n突出主题。";
    assert.deepEqual(extractNamingSections([
      "Unrelated introduction", first, "# 工程实践原则", "不要导入这一节。", second,
      "## 文档排版", "不要导入排版规则。",
    ].join("\n\n")), [first, second]);
  });

  it("recognizes case-insensitive English session/conversation naming and title headings", () => {
    const sections = [
      "## SESSION NAMING rules\nUse the user’s language.",
      "### Conversation title\nKeep the title concrete.",
      "### Naming sessions\nUse a short topic.",
      "### Titles for conversations ###\nPreserve supplied titles.",
    ];
    const source = sections.map(section => `${section}\n## Other rules\nEngineering content.`).join("\n");
    assert.deepEqual(extractNamingSections(source), sections);
  });

  it("keeps adjacent naming sections separate for excerpt deduplication", () => {
    const section = "## Session title\nKeep the topic concrete.";
    assert.deepEqual(extractNamingSections(`${section}\n${section}`), [section, section]);
  });

  it("does not turn arbitrary instructions, partial heading words, or invalid ATX into naming rules", () => {
    assert.deepEqual(extractNamingSections([
      "Use short session titles in this introduction.",
      "# Engineering", "Run tests.", "## Session lifecycle", "Read all logs.",
      "## Project title", "Project metadata.", "## Sessional naming", "Not a session heading.",
      "    # Session title", "Indented code.", "#Session title", "Missing heading space.",
      "####### Session title", "Too many hashes.",
    ].join("\n")), []);
    assert.deepEqual(extractNamingSections(undefined), []);
  });

  it("ignores both fence styles, including too-short or mismatched closing fences", () => {
    assert.deepEqual(extractNamingSections([
      "````markdown", "# 会话命名原则", "Hidden backtick rules.", "```", "# Session title",
      "~~~", "Still hidden.", "````", "  ~~~~text", "# Conversation naming", "Hidden tilde rules.",
      "  ~~~", "# 对话标题", "Still hidden.", "  ~~~~", "# Engineering", "Run tests.",
    ].join("\n")), []);
  });

  it("retains fenced examples within a genuine naming section without ending at fake headings", () => {
    const section = [
      "## Session title", "Use this example:", "```markdown", "# Engineering", start,
      "Fenced marker remains literal.", end, "```", "### Details", "Keep short.",
    ].join("\n");
    assert.deepEqual(extractNamingSections(`${section}\n## Build\nDo not include.`), [section]);
  });

  it("extracts balanced explicit blocks, including inline and nested blocks, in document order", () => {
    const source = [
      "Engineering introduction.", `${start}Use the conversation language.${end}`,
      "# Engineering", "Ignore this.", start, "Outer rule.", start, "Inner rule.", end, "Last rule.", end,
      "Ignore the trailing engineering rules.",
    ].join("\n");
    assert.deepEqual(extractNamingSections(source), [
      "Use the conversation language.", "Outer rule.\n\nInner rule.\n\nLast rule.",
    ]);
  });

  it("requires balanced active markers and ignores markers inside fences", () => {
    for (const source of [
      `${start}\nIncomplete instructions.`, `${end}\nUnopened instructions.`,
      `${start}\n${start}\nNested but incomplete.\n${end}`,
      `\`\`\`\n${start}\n\`\`\`\nHidden rule.\n${end}`,
      `${start}\n\`\`\`\n${end}\n\`\`\`\nStill not closed.`,
      `~~~\n${start}\nFake rule.\n${end}\n~~~`,
    ]) assert.deepEqual(extractNamingSections(source), [], source);
  });

  it("renders overlapping heading/block selections once and normalizes CRLF", () => {
    const source = `## 会话标题\r\nBefore.\r\n${start}\r\nSelected once.\r\n${end}\r\nAfter.\r\n## Engineering\r\nExcluded.`;
    assert.deepEqual(extractNamingSections(source), ["## 会话标题\nBefore.\n\nSelected once.\n\nAfter."]);
  });
});

describe("createInstructionReader", () => {
  it("stays lazy and returns empty for absent, relative, invalid, missing, or non-directory cwd", async t => {
    const f = await fixture(t);
    let calls = 0;
    const read = createInstructionReader({ discover: async () => { calls++; return []; } });
    assert.equal(calls, 0);
    const file = await f.add("AGENTS.md", "# 会话命名\nA rule.");
    for (const cwd of [undefined, null, "", ".", "relative/path", 12, `${f.cwd}\0bad`, join(f.cwd, "missing"), file.absolutePath]) {
      assert.deepEqual(await read({ cwd }), empty);
    }
    assert.equal(calls, 0);
    assert.deepEqual(await createInstructionReader()(), empty);
  });

  it("passes the public helper only cwd, cancellation, and AGENTS candidate configuration", async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    let passedSignal;
    const read = createInstructionReader({ discover: async options => {
      assert.deepEqual(Object.keys(options).sort(), ["cwd", "instructionFileCandidates", "localInstructionFileCandidates", "signal"]);
      assert.equal(options.cwd, f.cwd);
      assert.deepEqual(options.instructionFileCandidates, ["AGENTS.md"]);
      assert.deepEqual(options.localInstructionFileCandidates, ["AGENTS.local.md"]);
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      passedSignal = options.signal;
      return [];
    } });
    assert.deepEqual(await read({ cwd: f.cwd, signal: controller.signal }), empty);
    controller.abort();
    assert.equal(passedSignal.aborted, false, "completed reads detach caller cancellation");
  });

  it("reads broad-to-specific guidance with SDK display labels and excludes engineering sections", async t => {
    const f = await fixture(t);
    const broad = "# 会话命名原则\nUse the broad naming rule.";
    const local = "## Conversation title\nUse the local naming rule.";
    await f.add("global/AGENTS.md", `${broad}\n# 工程实践\nNever reveal this engineering section.`);
    await f.add("nested/AGENTS.local.md", `General preamble.\n${local}\n## Engineering\nDo not include.`);
    const read = createInstructionReader({ discover: f.discover });
    assert.deepEqual(await read({ cwd: f.cwd }), {
      text: `${label("global/AGENTS.md")}${broad}\n\n${label("nested/AGENTS.local.md")}${local}`,
      sources: ["global/AGENTS.md", "nested/AGENTS.local.md"],
    });
    assert.equal((await read({ cwd: f.cwd })).text.includes(f.cwd), false);
  });

  it("returns empty when discovered files are absent or have no selected naming rules", async t => {
    const f = await fixture(t);
    const read = createInstructionReader({ discover: f.discover });
    assert.deepEqual(await read({ cwd: f.cwd }), empty);
    await f.add("AGENTS.md", "# Engineering\nBuild this project.\n# Style\nKeep code short.");
    assert.deepEqual(await read({ cwd: f.cwd }), empty);
  });

  it("reads repeated paths once and deduplicates identical excerpts at the most specific source", async t => {
    const f = await fixture(t);
    const repeated = "## Session title\nShared rule.";
    const broad = "## Session naming\nBroad-only rule.";
    const specific = "## Conversation title\nSpecific-only rule.";
    const first = await f.add("AGENTS.md", `${broad}\n# Engineering\nSkip.\n${repeated}`);
    f.files.push({ ...first, displayPath: "duplicate-path/AGENTS.md" });
    await f.add("nested/AGENTS.local.md", `${repeated}\n# Engineering\nSkip.\n${specific}`);
    const read = createInstructionReader({ discover: f.discover });
    const result = await read({ cwd: f.cwd });
    assert.deepEqual(result.sources, ["AGENTS.md", "nested/AGENTS.local.md"]);
    assert.equal(result.text.match(/Shared rule\./gu)?.length, 1);
    assert.ok(result.text.indexOf("Broad-only") < result.text.indexOf("Shared rule"));
    assert.ok(result.text.indexOf("Shared rule") < result.text.indexOf("Specific-only"));
    assert.equal(result.text.includes("duplicate-path"), false);
  });

  it("keeps original excerpt order within each source and collapses equivalent trimmed excerpts", async t => {
    const f = await fixture(t);
    await f.add("AGENTS.md", ` \n${start} Keep brief. ${end}\n${start}Keep brief.${end}\n${start}Use context.${end}\n## 会话命名\n保留主题。\n## 会话命名\n保留主题。`);
    const result = await createInstructionReader({ discover: f.discover })({ cwd: f.cwd });
    assert.equal(result.text, `${label("AGENTS.md")}Keep brief.\n\nUse context.\n\n## 会话命名\n保留主题。`);
  });

  it("prefers more specific sources when the complete rendered text exceeds the UTF8 budget", async t => {
    const f = await fixture(t);
    await f.add("AGENTS.md", "# 会话命名\nBroad rule.");
    const specific = "# 对话标题\nSpecific rule.";
    await f.add("nested/AGENTS.local.md", specific);
    const expected = label("nested/AGENTS.local.md") + specific;
    const read = createInstructionReader({ discover: f.discover });
    const result = await read({ cwd: f.cwd, maxBytes: Buffer.byteLength(expected) });
    assert.deepEqual(result, { text: expected, sources: ["nested/AGENTS.local.md"], truncated: true });
  });

  it("bounds long Chinese and emoji excerpts without splitting UTF8, counting the entire display label", async t => {
    const f = await fixture(t);
    const source = "中文/AGENTS.md";
    const excerpt = "# 会话标题\n" + "主题😀标题🚀".repeat(2000);
    await f.add(source, excerpt);
    const read = createInstructionReader({ discover: f.discover });
    const fullText = label(source) + excerpt;
    const headerBytes = Buffer.byteLength(label(source));
    const headingBytes = Buffer.byteLength("# 会话标题\n");
    for (const maxBytes of [0, 1, headerBytes - 1, headerBytes, headerBytes + 1,
      ...Array.from({ length: 16 }, (_, index) => headerBytes + headingBytes + index), 4096]) {
      const result = await read({ cwd: f.cwd, maxBytes });
      assert.ok(Buffer.byteLength(result.text) <= maxBytes, `${maxBytes} byte budget`);
      assert.equal(result.truncated, true);
      assert.equal(result.text.includes("\ufffd"), false);
      assert.equal(fullText.startsWith(result.text), true);
      assert.deepEqual(result.sources, result.text ? [source] : []);
    }
    const defaultResult = await read({ cwd: f.cwd });
    assert.ok(Buffer.byteLength(defaultResult.text) <= 4096);
    assert.equal(defaultResult.truncated, true);
  });

  it("omits a source whose complete label and even one character cannot fit", async t => {
    const f = await fixture(t);
    await f.add("AGENTS.md", `${start}😀Only complete characters.${end}`);
    const result = await createInstructionReader({ discover: f.discover })({
      cwd: f.cwd, maxBytes: Buffer.byteLength(label("AGENTS.md")) + 3,
    });
    assert.deepEqual(result, { ...empty, truncated: true });
  });

  it("skips oversized files entirely while reading exactly-at-limit UTF8 sources", async t => {
    const f = await fixture(t);
    const exact = "# 会话标题\n" + "😀中文".repeat(30);
    const maxSourceBytes = Buffer.byteLength(exact);
    await f.add("AGENTS.md", `${exact}x`);
    await f.add("nested/AGENTS.local.md", exact);
    const result = await createInstructionReader({ discover: f.discover, maxSourceBytes })({ cwd: f.cwd });
    assert.deepEqual(result, {
      text: label("nested/AGENTS.local.md") + exact, sources: ["nested/AGENTS.local.md"], truncated: true,
    });
  });

  it("streams UTF8 safely across read boundaries and enforces the default one MiB source cap", async t => {
    const f = await fixture(t);
    const excerpt = "# Session title\n" + "😀中".repeat(12000);
    await f.add("AGENTS.md", excerpt);
    const read = createInstructionReader({ discover: f.discover });
    const result = await read({ cwd: f.cwd, maxBytes: 100000 });
    assert.equal(result.text, label("AGENTS.md") + excerpt);
    assert.equal(result.text.includes("\ufffd"), false);
    await writeFile(f.files[0].absolutePath, "# Session title\n" + "x".repeat(1048576), "utf8");
    assert.deepEqual(await read({ cwd: f.cwd }), { ...empty, truncated: true });
  });

  it("observes edits, deletions, re-creation, and newly discovered sources on successive calls", async t => {
    const f = await fixture(t);
    const file = await f.add("AGENTS.md", "# 会话标题\nOriginal rule.");
    const read = createInstructionReader({ discover: f.discover });
    assert.match((await read({ cwd: f.cwd })).text, /Original rule/u);
    await writeFile(file.absolutePath, "# 会话标题\nUpdated rule.", "utf8");
    const changed = await read({ cwd: f.cwd });
    assert.match(changed.text, /Updated rule/u);
    assert.doesNotMatch(changed.text, /Original rule/u);
    assert.equal(file.absolutePath, join(f.cwd, "AGENTS.md"));
    await rm(file.absolutePath);
    assert.deepEqual(await read({ cwd: f.cwd }), unavailable);
    await writeFile(file.absolutePath, "# Engineering\nNaming rule removed.", "utf8");
    assert.deepEqual(await read({ cwd: f.cwd }), empty);
    await f.add("nested/AGENTS.local.md", "# Conversation naming\nNew local rule.");
    assert.deepEqual((await read({ cwd: f.cwd })).sources, ["nested/AGENTS.local.md"]);
  });

  it("degrades discovery failure and recovers on a later call without caching failure", async t => {
    const f = await fixture(t);
    await f.add("AGENTS.md", "# Session title\nRecovered rule.");
    let failing = true;
    const read = createInstructionReader({ discover: async () => {
      if (failing) throw new Error("SDK unavailable");
      return f.files;
    } });
    assert.deepEqual(await read({ cwd: f.cwd }), unavailable);
    failing = false;
    assert.match((await read({ cwd: f.cwd })).text, /Recovered rule/u);
  });

  it("retains usable guidance when other file reads or discovery entries fail", async t => {
    const f = await fixture(t);
    f.files.push({ absolutePath: join(f.cwd, "missing.md"), displayPath: "missing/AGENTS.md" });
    f.files.push({ absolutePath: f.cwd, displayPath: "directory/AGENTS.md" });
    f.files.push(null, { absolutePath: "relative", displayPath: "invalid/AGENTS.md" });
    await f.add("AGENTS.md", "# Session naming\nKeep this available rule.");
    const result = await createInstructionReader({ discover: f.discover })({ cwd: f.cwd });
    assert.equal(result.unavailable, true);
    assert.deepEqual(result.sources, ["AGENTS.md"]);
    assert.match(result.text, /Keep this available rule/u);
    assert.equal(result.text.includes(f.cwd), false);
    assert.equal(result.text.includes("missing/"), false);
    assert.deepEqual(await createInstructionReader({ discover: async () => undefined })({ cwd: f.cwd }), unavailable);
  });

  it("propagates already-aborted caller cancellation before any discovery", async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    let called = false;
    const read = createInstructionReader({ discover: async () => { called = true; return []; } });
    await assert.rejects(read({ cwd: f.cwd, signal: controller.signal }), error => error === reason);
    assert.equal(called, false);
  });

  it("propagates caller cancellation even when discovery ignores its signal", async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    const reason = new Error("cancel in flight");
    let passedSignal;
    const read = createInstructionReader({ discover: options => {
      passedSignal = options.signal;
      controller.abort(reason);
      return new Promise(() => {});
    } });
    await assert.rejects(read({ cwd: f.cwd, signal: controller.signal }), error => error === reason);
    assert.equal(passedSignal.aborted, true);
    assert.equal(passedSignal.reason, reason);
  });

  it("propagates cancellation after discovery instead of turning it into unavailable", async t => {
    const f = await fixture(t);
    await f.add("AGENTS.md", "# Session naming\nDo not return after cancellation.");
    const controller = new AbortController();
    const read = createInstructionReader({ discover: async () => {
      controller.abort();
      return f.files;
    } });
    await assert.rejects(read({ cwd: f.cwd, signal: controller.signal }), error => error.name === "AbortError");
  });

  it("cancels an in-flight streamed file read with the caller's original reason", async t => {
    const f = await fixture(t);
    await f.add("AGENTS.md", "# Session title\n" + "😀中".repeat(100000));
    const controller = new AbortController();
    const reason = new Error("cancel the stream");
    const read = createInstructionReader({ discover: async () => {
      setImmediate(() => controller.abort(reason));
      return f.files;
    } });
    await assert.rejects(read({ cwd: f.cwd, signal: controller.signal }), error => error === reason);
  });

  it("bounds the whole operation and cancels discovery without aborting the caller signal", async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    let passedSignal;
    const read = createInstructionReader({ timeoutMs: 30, discover: options => {
      passedSignal = options.signal;
      return new Promise(() => {});
    } });
    const before = performance.now();
    assert.deepEqual(await read({ cwd: f.cwd, signal: controller.signal }), unavailable);
    assert.ok(performance.now() - before < 1500);
    assert.equal(passedSignal.aborted, true);
    assert.equal(passedSignal.reason.name, "TimeoutError");
    assert.equal(controller.signal.aborted, false);
  });
});
