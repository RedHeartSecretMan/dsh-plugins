import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFallbackTitle,
  buildSystemPrompt,
  cleanTitleText,
  compileTitlePattern,
  formatCjkSpacing,
  formatDate,
  frameMessages,
  isFormattedTitle,
  isSettledTitle,
  parseModelTitle,
  renderTitle,
  selectContextMessages,
} from "../lib/title.js";
import { DEFAULTS, resolveConfig } from "../lib/config.js";

const config = resolveConfig({});
const keys = config.types.map((entry) => entry.key);
const pattern = compileTitlePattern(config.template, keys);
const options = (date = "1025") => ({
  pattern,
  date,
  template: config.template,
  types: config.types,
  cjkSpacing: config.cjkSpacing,
  topicMaxChars: config.topicMaxChars,
});

describe("formatDate", () => {
  it("renders the Shanghai date of the given instant", () => {
    // 2026-10-24T17:30:00Z is 2026-10-25 01:30 in Shanghai.
    const millis = Date.UTC(2026, 9, 24, 17, 30);
    assert.equal(formatDate(millis, "Asia/Shanghai", "MMDD"), "1025");
  });

  it("crosses the date boundary in the configured zone only", () => {
    const millis = Date.UTC(2026, 9, 24, 17, 30);
    assert.equal(formatDate(millis, "UTC", "MMDD"), "1024");
  });

  it("supports the long year and separator formats", () => {
    const millis = Date.UTC(2026, 9, 24, 17, 30);
    assert.equal(formatDate(millis, "Asia/Shanghai", "YYYY-MM-DD"), "2026-10-25");
    assert.equal(formatDate(millis, "Asia/Shanghai", "YY.MM.DD"), "26.10.25");
  });

  it("rejects missing, mistyped, non-finite, and out-of-range creation times", () => {
    for (const timestamp of [undefined, null, "2026-10-25", Number.NaN, Infinity, -Infinity, 8.64e15 + 1]) {
      assert.throws(() => formatDate(timestamp, "UTC", "MMDD"), /createdAt.*valid/u);
    }
    assert.equal(formatDate(0, "UTC", "MMDD"), "0101");
  });
});

describe("cleanTitleText", () => {
  it("turns word-separating controls into a space and drops the rest", () => {
    // \n and \t separate words, so they become spaces; \u0000 does not, so "a"
    // and "b" stay adjacent.
    assert.equal(cleanTitleText("  a\u0000b\n\tc  "), "ab c");
  });

  it("removes every non-separating control character", () => {
    assert.equal(cleanTitleText("a\u0001\u001fb"), "ab");
  });

  it("returns an empty string for empty input", () => {
    assert.equal(cleanTitleText(""), "");
    assert.equal(cleanTitleText(undefined), "");
  });
});

describe("formatCjkSpacing", () => {
  it("inserts one space at each CJK boundary", () => {
    assert.equal(formatCjkSpacing("修复Git提交"), "修复 Git 提交");
    assert.equal(formatCjkSpacing("第2版发布"), "第 2 版发布");
  });

  it("leaves already spaced text unchanged", () => {
    assert.equal(formatCjkSpacing("修复 Git 提交"), "修复 Git 提交");
  });
});

describe("parseModelTitle", () => {
  it("accepts the exact template", () => {
    const parsed = parseModelTitle("[1025][修复] 排查登录失败", options());
    assert.equal(parsed.title, "[1025][修复] 排查登录失败");
    assert.equal(parsed.type, "修复");
    assert.equal(parsed.topic, "排查登录失败");
  });

  it("accepts full-width brackets", () => {
    assert.equal(parseModelTitle("【1025】【修复】排查登录失败", options()).title, "[1025][修复] 排查登录失败");
  });

  it("accepts a title with the date omitted", () => {
    assert.equal(parseModelTitle("[修复] 排查登录失败", options()).title, "[1025][修复] 排查登录失败");
  });

  it("replaces the model's date with the resolved date", () => {
    assert.equal(parseModelTitle("[0101][修复] 排查登录失败", options()).title, "[1025][修复] 排查登录失败");
  });

  it("strips quotes, emphasis, headings, and trailing punctuation", () => {
    const parsed = parseModelTitle('**"[1025][修复] 排查登录失败。"**', options());
    assert.equal(parsed.title, "[1025][修复] 排查登录失败");
  });

  it("reads the first matching line when the model adds commentary", () => {
    const raw = "Here is the title:\n[1025][功能] 新增导出功能\nThis keeps it short.";
    assert.equal(parseModelTitle(raw, options()).title, "[1025][功能] 新增导出功能");
  });

  it("rejects a type outside the vocabulary", () => {
    assert.equal(parseModelTitle("[1025][重构] 拆分类", options()), undefined);
  });

  it("rejects output with no template at all", () => {
    assert.equal(parseModelTitle("排查登录失败", options()), undefined);
    assert.equal(parseModelTitle("", options()), undefined);
  });

  it("truncates an over-long topic to the configured limit", () => {
    const long = "一".repeat(60);
    assert.equal(parseModelTitle(`[1025][修复] ${long}`, options()).topic.length, config.topicMaxChars);
  });

  it("honours an English template", () => {
    const english = resolveConfig({
      template: "[{date}][{type}] {topic}",
      language: "en",
      types: [
        { key: "fix", hint: "Bug fixes" },
        { key: "feat", hint: "New capability" },
      ],
      fallbackType: "fix",
      cjkSpacing: false,
    });
    const englishPattern = compileTitlePattern(english.template, english.types.map((entry) => entry.key));
    const parsed = parseModelTitle("[1025][fix] Repair login flow", {
      pattern: englishPattern,
      date: "1025",
      template: english.template,
      types: english.types,
      cjkSpacing: english.cjkSpacing,
      topicMaxChars: english.topicMaxChars,
    });
    assert.equal(parsed.title, "[1025][fix] Repair login flow");
  });
});

describe("isFormattedTitle and isSettledTitle", () => {
  it("treats a template-shaped title as formatted", () => {
    assert.equal(isFormattedTitle("[1025][修复] 排查登录失败", options()), true);
    assert.equal(isFormattedTitle("排查登录失败", options()), false);
  });

  it("keeps a provisional type unsettled and a concrete type settled", () => {
    assert.equal(isSettledTitle("[1025][探索] 了解网关设置", options()), false);
    assert.equal(isSettledTitle("[1025][修复] 排查登录失败", options()), true);
  });
});

describe("buildFallbackTitle", () => {
  it("derives a template-shaped title from the first message", () => {
    const title = buildFallbackTitle({
      date: "1025",
      template: config.template,
      fallbackType: config.fallbackType,
      sourceText: "帮我看看这个报错是怎么回事",
      cjkSpacing: config.cjkSpacing,
      topicMaxChars: config.topicMaxChars,
    });
    assert.match(title, /^\[1025\]\[探索\] \S/u);
  });

  it("uses the fallback type as the topic when the message is empty", () => {
    const title = buildFallbackTitle({
      date: "1025",
      template: config.template,
      fallbackType: config.fallbackType,
      sourceText: "   ",
      cjkSpacing: config.cjkSpacing,
      topicMaxChars: config.topicMaxChars,
    });
    assert.equal(title, "[1025][探索] 探索");
  });
});

describe("renderTitle", () => {
  it("renders every placeholder", () => {
    assert.equal(
      renderTitle("[{date}][{type}] {topic}", { date: "1025", type: "修复", topic: "排查失败" }),
      "[1025][修复] 排查失败"
    );
  });

  it("collapses the spacing a missing placeholder leaves behind", () => {
    assert.equal(renderTitle("{date} {topic}", { date: "1025", type: "修复", topic: "排查失败" }), "1025 排查失败");
  });
});

describe("template and canonical-title regressions", () => {
  const englishTypes = [{ key: "fix" }, { key: "explore", provisional: true }];
  const configured = (template, date = "2026/10/25") => ({
    template, date, types: englishTypes, cjkSpacing: false, topicMaxChars: 80,
    pattern: compileTitlePattern(template, englishTypes.map((entry) => entry.key)),
  });

  it("roundtrips every placeholder order, literal suffixes, wrappers, and dollar text", () => {
    const templates = [
      "{date} | {type}: {topic} <end>",
      "{date} | {topic} <{type}>",
      "{type}: {date} / {topic} <end>",
      "{type}: {topic} ({date})*",
      "{topic} :: {date} :: {type}",
      '"{topic}" / {type} / {date}',
      "# {topic} / {type} / {date}",
    ];
    for (const template of templates) {
      const current = configured(template);
      const title = renderTitle(template, { date: current.date, type: "fix", topic: "Repair $& flow" });
      assert.equal(parseModelTitle(title, current)?.title, title, template);
      assert.equal(isFormattedTitle(title, current), true, template);
    }
    assert.equal(renderTitle("{type} | {topic} | {date}", {
      type: "$&", topic: "$` $' $$ {date}", date: "1025",
    }), "$& | $` $' $$ {date} | 1025");
  });

  it("normalizes model wrappers without deleting literal template punctuation", () => {
    for (const template of ["{type}: {topic} ({date})*", '"{topic}" / {type} / {date}', "# {topic} / {type} / {date}"]) {
      const current = configured(template);
      const expected = renderTitle(template, { date: current.date, type: "fix", topic: "Repair flow" });
      const raw = renderTitle(template, { date: "0101", type: "FIX", topic: "Repair flow" });
      for (const wrapped of [`**${raw}**`, `"${raw}"`, `# ${raw}`]) {
        assert.equal(parseModelTitle(wrapped, current)?.title, expected, `${template}: ${wrapped}`);
      }
    }
  });

  it("validates stored titles strictly while still accepting lenient model output", () => {
    const current = configured("[{date}][{type}] {topic}", "1025");
    for (const title of [
      "[0101][fix] Repair flow", "[fix] Repair flow", "[][fix] Repair flow",
      "【1025】【fix】Repair flow", "[1025][FIX] Repair flow", "[1025][fix] Repair flow.",
      "[1025][fix]  Repair flow", " [1025][fix] Repair flow", "[1025][fix] Repair\nflow",
      "[1025][fix] ",
    ]) {
      assert.equal(isFormattedTitle(title, current), false, title);
      assert.equal(isSettledTitle(title, current), false, title);
    }
    assert.equal(isFormattedTitle("[1025][fix] Repair flow", current), true);
    assert.equal(isSettledTitle("[1025][fix] Repair flow", current), true);
    assert.equal(isFormattedTitle("[1025][explore] Goal", current), true);
    assert.equal(isSettledTitle("[1025][explore] Goal", current), false);
    assert.equal(isFormattedTitle("[1025][fix] Repair flow", { ...current, date: undefined }), false);
    assert.equal(parseModelTitle('**"【0101】【FIX】Repair flow。"**', current)?.title, "[1025][fix] Repair flow");
    assert.equal(parseModelTitle("[fix] Repair flow", current)?.title, "[1025][fix] Repair flow");
    assert.equal(isFormattedTitle("[1025][fix] Too long", { ...current, topicMaxChars: 3 }), false);
  });
});

describe("buildSystemPrompt", () => {
  it("lists every configured type and the resolved example", () => {
    const prompt = buildSystemPrompt({
      language: "zh",
      types: config.types,
      dateFormat: config.dateFormat,
      template: config.template,
      dateLabel: "1025",
      typeLabel: "修复",
      topicLabel: "主题",
      topicMinChars: config.topicMinChars,
      topicMaxChars: config.topicMaxChars,
      cjkSpacing: config.cjkSpacing,
      isRefining: false,
      hint: undefined,
    });
    for (const entry of config.types) assert.ok(prompt.includes(entry.key), `missing type ${entry.key}`);
    assert.ok(prompt.includes("[1025][修复] 主题"));
    assert.ok(prompt.includes("单行"));
  });

  it("includes the retitle hint when one is supplied", () => {
    const prompt = buildSystemPrompt({
      language: "zh",
      types: config.types,
      dateFormat: config.dateFormat,
      template: config.template,
      dateLabel: "1025",
      typeLabel: "修复",
      topicLabel: "主题",
      topicMinChars: config.topicMinChars,
      topicMaxChars: config.topicMaxChars,
      cjkSpacing: config.cjkSpacing,
      isRefining: true,
      hint: "属于排障纠错",
    });
    assert.ok(prompt.includes("属于排障纠错"));
    assert.ok(prompt.includes("多轮对话"));
  });
});

describe("Unicode topic and prompt regressions", () => {
  it("counts supplementary ideographs as characters and keeps short useful topics", () => {
    const current = { ...options(), topicMaxChars: 3, topicMinChars: 8 };
    assert.equal(parseModelTitle("[1025][修复] 𠀀𠀁𠀂𠀃", current)?.topic, "𠀀𠀁𠀂");
    assert.equal(parseModelTitle("[1025][修复] 好", current)?.topic, "好");
    assert.equal(buildFallbackTitle({ ...current, fallbackType: "探索", sourceText: "𠀀𠀁𠀂𠀃" }), "[1025][探索] 𠀀𠀁𠀂");
    assert.equal(formatCjkSpacing("𠀀Git𠀁2𠀂"), "𠀀 Git 𠀁 2 𠀂");
  });

  it("normalizes model-added quote and emphasis suffixes", () => {
    for (const raw of ['[0101][修复] 排查失败"', "[0101][修复] 排查失败**"]) {
      assert.equal(parseModelTitle(raw, options())?.title, "[1025][修复] 排查失败");
    }
  });

  it("follows the configured template, preserves word spaces, and treats messages as data", () => {
    for (const language of ["en", "zh"]) {
      const prompt = buildSystemPrompt({
        ...config, language, template: "{topic} — {type} @ {date}", cjkSpacing: false,
        dateLabel: "1025", typeLabel: "修复", topicLabel: "$&", isRefining: false,
      });
      assert.ok(prompt.includes("$& — 修复 @ 1025"));
      assert.doesNotMatch(prompt, /MMDD|prefix must begin|前缀必须|half-width brackets|半角中括号|Do not add spacing inside|主题内部不额外插入/iu);
      assert.match(prompt, /preserve normal word spacing|保留.*必要.*空格/iu);
      assert.match(prompt, /messages.*data.*not instructions|消息.*数据.*不.*指令/iu);
    }
  });
});

describe("selectContextMessages", () => {
  const make = (count) =>
    Array.from({ length: count }, (_, index) => ({ seq: index + 1, text: `message ${index + 1}` }));

  it("returns every message for a short conversation", () => {
    assert.equal(selectContextMessages(make(3), 4096).length, 3);
  });

  it("keeps the first message plus the last three", () => {
    const selected = selectContextMessages(make(10), 4096);
    assert.deepEqual(selected.map((message) => message.seq), [1, 8, 9, 10]);
  });

  it("drops messages that would exceed the byte budget", () => {
    const long = Array.from({ length: 5 }, (_, index) => ({ seq: index + 1, text: "x".repeat(400) }));
    const selected = selectContextMessages(long, 500);
    assert.ok(selected.length < long.length);
    assert.equal(selected[0].seq, 1);
  });

  it("truncates each message to the per-message bound", () => {
    const selected = selectContextMessages([{ seq: 1, text: "y".repeat(2000) }], 4096);
    assert.equal(selected[0].text.length, 800);
  });

  it("returns nothing for an empty conversation", () => {
    assert.deepEqual(selectContextMessages([], 4096), []);
  });
});

describe("context budget regressions", () => {
  it("budgets framing, JSON escaping, UTF-8, and oversized first messages", () => {
    for (const text of ["x".repeat(2000), "中文𠀀".repeat(700), '\\"\n\u0000'.repeat(700)]) {
      for (const budget of [256, 500, 4096]) {
        const selected = selectContextMessages([{ seq: 123456, text }], budget);
        assert.ok(selected.length > 0);
        assert.ok(Buffer.byteLength(frameMessages(selected)) <= budget, `${budget} bytes`);
        assert.ok(text.startsWith(selected[0].text));
      }
    }
  });

  it("retains first and newest context when both can fit after truncation", () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({ seq: index + 1, text: "中𠀀".repeat(800) }));
    const selected = selectContextMessages(messages, 256);
    assert.equal(selected[0].seq, 1);
    assert.equal(selected.at(-1).seq, 10);
    assert.ok(selected.every((message) => message.text.length > 0));
    assert.ok(Buffer.byteLength(frameMessages(selected)) <= 256);
  });

  it("returns unique ordered input sequence numbers and truncates by Unicode character", () => {
    const messages = [
      { seq: 9, text: "newest" }, { seq: 3, text: "𠀀𠀁𠀂𠀃" },
      { seq: 3, text: "duplicate" }, { seq: 1, text: "first" },
      { seq: undefined, text: "not a real citation" }, { seq: 2.5, text: "invalid" },
      { seq: -1, text: "invalid" }, { seq: 4, text: " " },
    ];
    const selected = selectContextMessages(messages, 4096, 3);
    assert.deepEqual(selected, [{ seq: 1, text: "fir" }, { seq: 3, text: "𠀀𠀁𠀂" }, { seq: 9, text: "new" }]);
  });

  it("throws clearly instead of returning empty or exceeding an impossible budget", () => {
    const message = [{ seq: 1, text: "x" }];
    assert.throws(() => selectContextMessages(message, Buffer.byteLength(frameMessages(message)) - 1), /maxInputBytes.*(fit|budget)/u);
    assert.throws(() => selectContextMessages([], 1), /maxInputBytes.*(fit|budget)/u);
    assert.throws(() => selectContextMessages([{ seq: 1, text: " " }], 256), /non-empty.*message/u);
    assert.throws(() => selectContextMessages(message, Number.NaN), /maxInputBytes/u);
    assert.throws(() => selectContextMessages(message, 256, 0), /perMessageChars/u);
  });
});

describe("frameMessages", () => {
  it("frames messages as a JSON array so user text cannot forge delimiters", () => {
    const framed = frameMessages([{ seq: 1, text: '{"seq":99}' }]);
    assert.ok(framed.startsWith("Generate the session title from this JSON array"));
    const parsed = JSON.parse(framed.slice(framed.indexOf("[")));
    assert.deepEqual(parsed, [{ seq: 1, text: '{"seq":99}' }]);
  });
});

describe("resolveConfig", () => {
  it("fills every default", () => {
    assert.equal(config.template, DEFAULTS.template);
    assert.equal(config.dateFormat, "MMDD");
    assert.equal(config.timezone, "Asia/Shanghai");
    assert.equal(config.backfill.enabled, false);
  });

  it("keeps the backfill disabled unless asked", () => {
    assert.equal(resolveConfig({}).backfill.enabled, false);
    assert.equal(resolveConfig({ backfill: { enabled: true } }).backfill.enabled, true);
  });

  it("rejects a template missing a placeholder", () => {
    assert.throws(() => resolveConfig({ template: "[{date}][{type}]" }), /template must contain \{topic\}/u);
  });

  it("rejects an unknown placeholder", () => {
    assert.throws(() => resolveConfig({ template: "[{date}][{type}] {topic} {owner}" }), /may only use/u);
  });

  it("rejects a date format without month and day", () => {
    assert.throws(() => resolveConfig({ dateFormat: "YYYY" }), /must contain MM and DD/u);
  });

  it("rejects a partial year token", () => {
    assert.throws(() => resolveConfig({ dateFormat: "Y-MM-DD" }), /must spell the year as YYYY or YY/u);
  });

  it("rejects an unknown time zone", () => {
    assert.throws(() => resolveConfig({ timezone: "Mars/Olympus" }), /not a time zone/u);
  });

  it("rejects an unknown language", () => {
    assert.throws(() => resolveConfig({ language: "fr" }), /must be "zh" or "en"/u);
  });

  it("rejects a fallback type outside the vocabulary", () => {
    assert.throws(() => resolveConfig({ fallbackType: "重构" }), /must be one of the configured types/u);
  });

  it("rejects duplicated type keys", () => {
    assert.throws(() => resolveConfig({ types: ["修复", "修复"] }), /must not repeat a key/u);
  });

  it("rejects a reversed topic range", () => {
    assert.throws(
      () => resolveConfig({ topicMinChars: 20, topicMaxChars: 10 }),
      /must not be smaller than topicMinChars/u
    );
  });

  it("rejects a negative timeout", () => {
    assert.throws(() => resolveConfig({ timeoutMs: 0 }), /timeoutMs must be an integer/u);
  });

  it("accepts a custom vocabulary and freezes it", () => {
    const custom = resolveConfig({
      types: [
        { key: "fix", hint: "Bugs" },
        { key: "feat", hint: "Features", provisional: true },
      ],
      fallbackType: "feat",
    });
    assert.equal(custom.types.length, 2);
    assert.equal(custom.types[1].provisional, true);
    assert.equal(Object.isFrozen(custom.types), true);
    assert.equal(Object.isFrozen(custom), true);
  });

  it("accepts retitle entries for the backfill", () => {
    const retitle = resolveConfig({
      backfill: { enabled: true, retitle: [{ id: "session-1", hint: "属于修复" }] },
    });
    assert.deepEqual(retitle.backfill.retitle, [{ id: "session-1", hint: "属于修复" }]);
  });

  it("rejects a retitle entry without an id", () => {
    assert.throws(() => resolveConfig({ backfill: { retitle: [{ hint: "x" }] } }), /id must be a non-empty string/u);
  });
});
