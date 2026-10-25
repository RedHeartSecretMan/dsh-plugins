import assert from "node:assert/strict";
import { it } from "node:test";
import { DEFAULTS, resolveConfig } from "../lib/config.js";

it("defaults AGENTS naming guidance and freezes independent resolved settings", () => {
  assert.deepEqual(DEFAULTS.agentsInstructions, { enabled: true, maxBytes: 4096 });
  const defaults = resolveConfig();
  assert.deepEqual(defaults.agentsInstructions, { enabled: true, maxBytes: 4096 });
  assert.deepEqual(resolveConfig({ agentsInstructions: {} }).agentsInstructions, defaults.agentsInstructions);
  assert.deepEqual(resolveConfig({ agentsInstructions: { enabled: false } }).agentsInstructions, { enabled: false, maxBytes: 4096 });
  assert.deepEqual(resolveConfig({ agentsInstructions: { maxBytes: 8192 } }).agentsInstructions, { enabled: true, maxBytes: 8192 });
  const input = { enabled: true, maxBytes: 1024 };
  const resolved = resolveConfig({ agentsInstructions: input });
  input.enabled = false;
  input.maxBytes = 256;
  assert.deepEqual(resolved.agentsInstructions, { enabled: true, maxBytes: 1024 });
  assert.ok(Object.isFrozen(resolved.agentsInstructions));
  assert.throws(() => { resolved.agentsInstructions.enabled = false; }, TypeError);
  assert.notStrictEqual(defaults.agentsInstructions, DEFAULTS.agentsInstructions);
  assert.notStrictEqual(defaults.agentsInstructions, resolveConfig().agentsInstructions);
});

it("strictly validates AGENTS naming guidance fields and byte boundaries", () => {
  for (const value of [null, false, "enabled", [], 4096]) {
    assert.throws(() => resolveConfig({ agentsInstructions: value }), /agentsInstructions must be an object/u);
  }
  assert.throws(() => resolveConfig({ agentsInstructions: { enable: true } }), /agentsInstructions\.enable is an unknown key/u);
  for (const enabled of [null, "false", 0, 1]) {
    assert.throws(() => resolveConfig({ agentsInstructions: { enabled } }), /agentsInstructions\.enabled must be a boolean/u);
  }
  for (const maxBytes of [256, 65536]) {
    assert.equal(resolveConfig({ agentsInstructions: { maxBytes } }).agentsInstructions.maxBytes, maxBytes);
  }
  for (const maxBytes of [255, 65537, 256.5, NaN, Infinity, "4096", null]) {
    assert.throws(() => resolveConfig({ agentsInstructions: { maxBytes } }), /agentsInstructions\.maxBytes must be an integer from 256 to 65536/u);
  }
  assert.throws(() => resolveConfig({ agentsInstructions: { enabled: false, maxBytes: 0 } }), /agentsInstructions\.maxBytes/u);
});

it("maps legacy aliases to the existing public config and rejects conflicting values", () => {
  const resolved = resolveConfig({
    maxExploreRefinements: 7,
    retitle: [{ id: "session-1", hint: "repair" }],
  });
  assert.equal(resolved.maxProvisionalRefinements, 7);
  assert.deepEqual(resolved.backfill.retitle, [{ id: "session-1", hint: "repair" }]);
  assert.equal(resolveConfig({ maxExploreRefinements: 7, maxProvisionalRefinements: 7 }).maxProvisionalRefinements, 7);
  assert.deepEqual(resolveConfig({ retitle: [{ id: "session-1" }], backfill: { retitle: [{ id: "session-1", hint: "" }] } }).backfill.retitle,
    [{ id: "session-1", hint: "" }]);
  assert.throws(() => resolveConfig({ maxExploreRefinements: 2, maxProvisionalRefinements: 3 }), /maxExploreRefinements.*conflicts.*maxProvisionalRefinements/u);
  assert.throws(() => resolveConfig({ retitle: [{ id: "old" }], backfill: { retitle: [{ id: "new" }] } }), /retitle.*conflicts.*backfill\.retitle/u);
});

it("rejects unknown keys at every supported config boundary", () => {
  const cases = [
    [{ maxInputByte: 300 }, "maxInputByte"],
    [{ backfill: { enable: true } }, "backfill.enable"],
    [{ backfill: { fallbackRoute: { provider: "p", model: "m", extra: true } } }, "backfill.fallbackRoute.extra"],
    [{ types: [{ key: "fix", hints: "typo" }, "feat"], fallbackType: "fix" }, "types[0].hints"],
    [{ retitle: [{ id: "one", hints: "typo" }] }, "retitle[0].hints"],
  ];
  for (const [input, field] of cases) {
    assert.throws(() => resolveConfig(input), (error) => error.message.includes(field) && /unknown/u.test(error.message), field);
  }
});

it("requires paired routes and strictly typed vocabulary, flags, and hints", () => {
  for (const input of [{ provider: "p" }, { model: "m" }]) {
    assert.throws(() => resolveConfig(input), /provider.*model.*together/u);
  }
  for (const key of ["[fix]", "bad{type}", "bad\u0000type", "bad\ntype"]) {
    for (const entry of [key, { key }]) {
      assert.throws(() => resolveConfig({ types: [entry, "feat"], fallbackType: "feat" }), /types\[0\].*(braces|brackets|control)/u);
    }
  }
  assert.throws(() => resolveConfig({ types: ["Fix", "fix"], fallbackType: "Fix" }), /must not repeat a key/u);
  assert.throws(() => resolveConfig({ types: [{ key: "fix", provisional: "false" }, "feat"], fallbackType: "fix" }), /provisional must be a boolean/u);
  assert.throws(() => resolveConfig({ types: [{ key: "fix", hint: 1 }, "feat"], fallbackType: "fix" }), /hint must be a string/u);
  assert.throws(() => resolveConfig({ retitle: [{ id: "one", hint: false }] }), /hint must be a string/u);
  assert.throws(() => resolveConfig({ maxExploreRefinements: null }), /maxProvisionalRefinements must be an integer/u);
  assert.throws(() => resolveConfig({ retitle: null }), /retitle must be an array/u);
  assert.equal(resolveConfig({ provider: "p", model: "m" }).provider, "p");
});

it("accepts each placeholder exactly once and only complete date tokens", () => {
  for (const template of ["{date} {date} {type} {topic}", "{date} {type} {topic}}", "{{date} {type} {topic}", "{date} {type} {topic} {owner}"]) {
    assert.throws(() => resolveConfig({ template }), /template/u, template);
  }
  for (const dateFormat of ["YYYYY-MM-DD", "YYY-MM-DD", "MM-DDD", "MMM-DD", "MM-DD-Y", "MMDDZ"]) {
    assert.throws(() => resolveConfig({ dateFormat }), /dateFormat/u, dateFormat);
  }
  for (const dateFormat of ["MMDD", "YYYY-MM-DD", "YY.MM.DD", "DD/MM_YYYY"]) {
    assert.equal(resolveConfig({ dateFormat }).dateFormat, dateFormat);
  }
});
