import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, resolveConfig } from '../lib/config.js';
import {
  applySettings,
  applyYamlConfig,
  formatFullConfigYaml,
  formatRawConfigYaml,
  settingsOptions,
  settingsValues,
} from '../lib/settings.js';
import { loadModelCatalog, registerSettingsRoute, SETTINGS_ROUTE_PATH } from '../lib/settings-route.js';

function createMockResponse() {
  const headers = new Map();
  let body = '';
  return {
    statusCode: 0,
    headers,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    end(chunk = '') { body += String(chunk); },
    json() { return JSON.parse(body); },
  };
}

const owner = { principal: { kind: 'owner' } };
const json = { 'content-type': 'application/json' };

function setup({ raw = {}, editor, llm, entry = { options: { id: 'session-title-template' } } } = {}) {
  const routes = [];
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } }, effect() {} };
  const config = resolveConfig(raw);
  registerSettingsRoute(ctx, { config, rawConfig: raw, llm, getEditor: () => ({ editor, entry }) });
  return { handler: routes[0].handler, route: routes[0], config };
}

test('values and options describe every editable field from a resolved config', () => {
  const config = resolveConfig({
    template: '({date}) {type}: {topic}',
    provider: 'p',
    model: 'm',
    subagentRoute: { provider: 'sub-p', model: 'sub-m' },
    maxProvisionalRefinements: 6,
    agentsInstructions: { enabled: true, maxBytes: 8192 },
    backfill: { enabled: true, fallbackRoute: { provider: 'fb-p', model: 'fb-m' } },
    maxInputBytes: 8192,
    maxOutputTokens: 2048,
    timeoutMs: 30000,
    retryAttempts: 2,
    retryDelayMs: 250,
  });
  const values = settingsValues(config);
  assert.equal(values.template, '({date}) {type}: {topic}');
  assert.equal(values.uiLanguage, 'auto');
  assert.equal(values.subagentDelegationLabel, true);
  assert.equal(values.provider, 'p');
  assert.equal(values.model, 'm');
  assert.equal(values.subagentProvider, 'sub-p');
  assert.equal(values.subagentModel, 'sub-m');
  assert.equal(values.fallbackProvider, 'fb-p');
  assert.equal(values.fallbackModel, 'fb-m');
  assert.equal(values.backfill, true);
  assert.equal(values.roleProbe, true);
  assert.equal(values.agentsInstructionsMaxBytes, 8192);
  assert.equal(values.maxProvisionalRefinements, 6);
  assert.equal(values.maxInputBytes, 8192);
  assert.equal(values.maxOutputTokens, 2048);
  assert.equal(values.timeoutMs, 30000);
  assert.equal(values.retryAttempts, 2);
  assert.equal(values.retryDelayMs, 250);
  assert.ok(Array.isArray(values.types) && values.types.length === DEFAULTS.types.length);
  assert.equal(values.types.find(item => item.key === '探索').provisional, true);
  assert.equal(values.types.find(item => item.key === '探索').maxRefinements, 6);
  assert.equal(values.types.find(item => item.key === '功能').provisional, false);
  assert.equal('maxRefinements' in values.types.find(item => item.key === '功能'), false);

  const defaults = settingsValues(resolveConfig({}));
  assert.equal(defaults.provider, '');
  assert.equal(defaults.subagentProvider, '');
  assert.equal(defaults.subagentModel, '');
  assert.equal(defaults.fallbackProvider, '');
  assert.equal(defaults.fallbackModel, '');

  const opts = settingsOptions(config, [{ id: 'p', name: 'Provider P', models: [{ id: 'm', name: 'Model M' }] }]);
  assert.deepEqual(opts.languages, ['zh', 'en']);
  assert.ok(opts.types.includes('探索'));
  assert.equal(opts.defaultTypes.length, DEFAULTS.types.length);
  assert.deepEqual(opts.uiLanguages, ['auto', 'zh', 'en']);
  assert.equal(opts.presets.en.fallbackType, 'explore');
  assert.equal(opts.presets.en.types[0].key, 'feat');
  assert.equal(opts.models[0].id, 'p');
});

test('a change set merges into the raw config without mutating it or dropping siblings like backfill.retitle', () => {
  const raw = {
    language: 'zh',
    backfill: {
      enabled: false,
      fallbackRoute: { provider: 'b', model: 'bm' },
      retitle: [{ id: 'sess-1', hint: 'Keep API nouns' }],
    },
    types: ['a', 'b'],
    fallbackType: 'a',
  };
  const frozen = structuredClone(raw);
  const next = applySettings(raw, {
    language: 'en',
    backfill: true,
    topicMaxChars: 30,
    agentsInstructionsMaxBytes: 8192,
    timeoutMs: 45000,
  });
  assert.deepEqual(raw, frozen, 'the input is never mutated');
  assert.equal(next.language, 'en');
  assert.deepEqual(next.backfill, {
    enabled: true,
    fallbackRoute: { provider: 'b', model: 'bm' },
    retitle: [{ id: 'sess-1', hint: 'Keep API nouns' }],
  }, 'fallbackRoute and retitle survive a toggle');
  assert.deepEqual(next.types, ['a', 'b']);
  assert.equal(next.topicMaxChars, 30);
  assert.deepEqual(next.agentsInstructions, { maxBytes: 8192 });
  assert.equal(next.timeoutMs, 45000);
});

test('provider/model and fallbackProvider/fallbackModel set and clear cleanly while preserving siblings', () => {
  const cleared = applySettings({ provider: 'p', model: 'm' }, { provider: '  ', model: '' });
  assert.equal('provider' in cleared, false);
  assert.equal('model' in cleared, false);

  const setFb = applySettings(
    { backfill: { enabled: false, retitle: [{ id: 's1', hint: 'h' }] } },
    { fallbackProvider: 'deepseek', fallbackModel: 'deepseek-chat' },
  );
  assert.deepEqual(setFb.backfill, {
    enabled: false,
    retitle: [{ id: 's1', hint: 'h' }],
    fallbackRoute: { provider: 'deepseek', model: 'deepseek-chat' },
  });

  const clearedFb = applySettings(setFb, { fallbackProvider: '', fallbackModel: '' });
  assert.equal('fallbackRoute' in clearedFb.backfill, false);
  assert.deepEqual(clearedFb.backfill.retitle, [{ id: 's1', hint: 'h' }]);
});

test('types updates normalize entries and remove redundant types override when restored to defaults', () => {
  const customTypes = [
    { key: 'feat', hint: 'New capabilities', provisional: false },
    { key: 'explore', hint: 'Initial investigation', provisional: true },
  ];
  const updated = applySettings({}, { types: customTypes, fallbackType: 'explore', maxProvisionalRefinements: 5 });
  assert.deepEqual(updated.types, [
    { key: 'feat', hint: 'New capabilities' },
    { key: 'explore', hint: 'Initial investigation', provisional: true },
  ]);
  assert.equal(updated.fallbackType, 'explore');
  assert.equal(updated.maxProvisionalRefinements, 5);

  const restored = applySettings(updated, {
    types: DEFAULTS.types.map(t => ({ key: t.key, hint: t.hint, provisional: t.provisional === true })),
    fallbackType: '探索',
  });
  assert.equal('types' in restored, false, 'restoring default types removes redundant override');
});

test('unknown, mistyped and invalid values are rejected with the invalid-settings code', () => {
  const reject = (changes, pattern) => assert.throws(
    () => applySettings({}, changes),
    error => error.code === 'invalid-settings' && pattern.test(error.message),
  );
  reject({ unknownKey: 'x' }, /not an editable setting/u);
  reject({ template: '{date} {topic}' }, /\{type\}/u);
  reject({ language: 'fr' }, /language/u);
  reject({ topicMaxChars: '9' }, /integer/u);
  reject({ topicMaxChars: 1.5 }, /integer/u);
  reject({ cjkSpacing: 'yes' }, /boolean/u);
  reject({ timezone: 'Mars/Base' }, /time zone/u);
  reject({ dateFormat: 'YYYY' }, /MM and DD/u);
  reject({ topicMinChars: 40 }, /topicMaxChars/u);
  reject({ provider: 'only' }, /together/u);
  reject({ subagentProvider: 'only', subagentModel: '' }, /together/u);
  reject({ fallbackProvider: 'only', fallbackModel: '' }, /together/u);
  reject({ fallbackType: '未知' }, /configured types/u);
  reject({ types: [{ key: 'only', hint: '' }] }, /at least two/u);
  reject({ types: [{ key: 'a', hint: '', provisional: false, maxRefinements: 3 }, { key: 'b', hint: '' }], fallbackType: 'a' }, /provisional/u);
  reject({ types: 'not-an-array' }, /array/u);
  reject({ timeoutMs: 500 }, /timeoutMs/u);
  reject({ retryAttempts: 9 }, /retryAttempts/u);
  reject({}, /at least one/u);
  reject([], /object/u);
});

test('applyYamlConfig parses and validates full YAML documents and rejects syntax or schema issues', () => {
  const parsed = applyYamlConfig([
    "template: '[{date}][{type}] {topic}'",
    'language: en',
    'types:',
    '  - key: feat',
    '    hint: New feature',
    '  - key: fix',
    '    hint: Bug fix',
    '    provisional: true',
    'fallbackType: fix',
    'backfill:',
    '  enabled: false',
    '  retitle:',
    '    - id: S1',
    '      hint: Re-summarize',
  ].join('\n'));
  assert.equal(parsed.language, 'en');
  assert.equal(parsed.backfill.retitle[0].id, 'S1');

  assert.throws(
    () => applyYamlConfig('language: "unterminated\n'),
    error => error.code === 'invalid-yaml' && /line 1/u.test(error.message),
  );
  assert.throws(
    () => applyYamlConfig('- a\n- b\n'),
    error => error.code === 'invalid-settings' && /mapping/u.test(error.message),
  );
  assert.throws(
    () => applyYamlConfig('unknownKey: true\n'),
    error => error.code === 'invalid-settings' && /unknown key/u.test(error.message),
  );
  assert.ok(formatRawConfigYaml({ language: 'zh' }).includes('language: zh'));
  const fullYaml = formatFullConfigYaml(resolveConfig({}));
  for (const key of Object.keys(DEFAULTS)) {
    assert.ok(fullYaml.includes(`${key}:`), `fullYaml must cover config.${key}`);
  }
  assert.ok(fullYaml.includes('# provider:'), 'fullYaml shows commented provider example when unset');
  assert.ok(fullYaml.includes('# model:'), 'fullYaml shows commented model example when unset');
  assert.ok(fullYaml.includes('# subagentRoute:'), 'fullYaml shows commented subagentRoute example when unset');
  assert.ok(fullYaml.includes('  # fallbackRoute:'), 'fullYaml shows commented backfill.fallbackRoute when unset');
  assert.ok(fullYaml.includes('  # retitle:'), 'fullYaml shows commented backfill.retitle when empty');
  assert.deepEqual(
    settingsValues(resolveConfig(applyYamlConfig(fullYaml))),
    settingsValues(resolveConfig({})),
    'fullYaml round-trips identically through applyYamlConfig and resolveConfig',
  );
  // Uncommenting the optional examples produces a valid YAML document too.
  const uncommented = fullYaml.replace(/^(\s*)# /gmu, '$1');
  const parsedUncommented = applyYamlConfig(uncommented);
  assert.equal(parsedUncommented.provider, '<provider-id>');
  assert.equal(parsedUncommented.subagentRoute.model, '<model-id>');
  assert.equal(parsedUncommented.backfill.fallbackRoute.model, '<model-id>');
  assert.equal(parsedUncommented.backfill.retitle[0].id, '<session-id>');
});

test('applySettings handles subagentRoute and per-type provisional refinement counts cleanly', () => {
  const withSub = applySettings({}, { subagentProvider: 'fast', subagentModel: 'flash' });
  assert.deepEqual(withSub.subagentRoute, { provider: 'fast', model: 'flash' });
  const clearedSub = applySettings(withSub, { subagentProvider: '', subagentModel: '' });
  assert.equal('subagentRoute' in clearedSub, false);

  // Changing only the default provisional type's limit stays compact (writes maxProvisionalRefinements, omits types).
  const onlyCountChanged = applySettings({}, {
    types: DEFAULTS.types.map(t => ({
      key: t.key,
      hint: t.hint,
      provisional: t.provisional === true,
      ...(t.provisional === true ? { maxRefinements: 7 } : {}),
    })),
  });
  assert.equal('types' in onlyCountChanged, false);
  assert.equal(onlyCountChanged.maxProvisionalRefinements, 7);

  // Adding a second provisional type with its own limit persists per-type maxRefinements cleanly.
  const multiProvisional = applySettings({}, {
    types: DEFAULTS.types.map(t => ({
      key: t.key,
      hint: t.hint,
      provisional: t.key === '探索' || t.key === '研究',
      ...(t.key === '探索' ? { maxRefinements: 6 } : {}),
      ...(t.key === '研究' ? { maxRefinements: 2 } : {}),
    })),
  });
  assert.equal(multiProvisional.types.find(t => t.key === '探索').maxRefinements, 6);
  assert.equal(multiProvisional.types.find(t => t.key === '研究').maxRefinements, 2);
  const resolved = settingsValues(resolveConfig(multiProvisional));
  assert.equal(resolved.types.find(t => t.key === '探索').maxRefinements, 6);
  assert.equal(resolved.types.find(t => t.key === '研究').maxRefinements, 2);
});

test('loadModelCatalog discovers providers/models and tolerates failing adapters', async () => {
  const catalog = await loadModelCatalog({
    listProviders: () => [
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'broken', name: 'Broken' },
      { id: 'empty', name: 'Empty' },
    ],
    async listModels(provider) {
      if (provider === 'deepseek') {
        return [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }];
      }
      if (provider === 'broken') throw new Error('network down');
      return [];
    },
  });
  assert.deepEqual(catalog, [
    { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
  ]);
  assert.deepEqual(await loadModelCatalog(undefined), []);
});

test('the settings route is owner-only and reports editability, values, models and YAML on GET', async () => {
  const llm = {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }],
  };
  const { handler, route } = setup({ raw: { language: 'zh' }, editor: { edit: async () => {} }, llm });
  assert.equal(route.auth, 'required');
  assert.equal(route.path, SETTINGS_ROUTE_PATH);

  const denied = createMockResponse();
  await handler({ method: 'GET' }, denied, { principal: { kind: 'guest' } });
  assert.equal(denied.statusCode, 403);

  const ok = createMockResponse();
  await handler({ method: 'GET' }, ok, owner);
  assert.equal(ok.statusCode, 200);
  const body = ok.json();
  assert.equal(body.editable, true);
  assert.equal(body.values.language, 'zh');
  assert.equal(body.options.models.length, 1);
  assert.equal(body.options.models[0].models[0].id, 'deepseek-chat');
  assert.ok(body.yaml.includes('language: zh'));
  assert.ok(body.fullYaml.includes('maxOutputTokens: 4096'));
  assert.equal(ok.headers.get('cache-control'), 'no-store');

  const noEditor = setup({});
  const unavailable = createMockResponse();
  await noEditor.handler({ method: 'GET' }, unavailable, owner);
  assert.equal(unavailable.json().editable, false);
  assert.equal(unavailable.json().reason, 'editor-unavailable');

  const wrong = createMockResponse();
  await handler({ method: 'DELETE' }, wrong, owner);
  assert.equal(wrong.statusCode, 405);
});

test('POST persists form changes, YAML documents, and resets through the config editor', async () => {
  const calls = [];
  const raw = { language: 'zh' };
  const inherited = { language: 'zh', timezone: 'Asia/Shanghai' };
  const editor = {
    async edit(entry, change) {
      const next = change(structuredClone(raw), structuredClone(inherited));
      calls.push({ entry, next });
    },
  };
  const { handler } = setup({ raw, editor });

  // 1. Form patch
  const formRes = createMockResponse();
  await handler({ method: 'POST', headers: json, body: { changes: { language: 'en', backfill: true } } }, formRes, owner);
  assert.equal(formRes.statusCode, 200);
  assert.equal(formRes.json().saved, true);
  assert.equal(formRes.json().restarted, true);
  assert.equal(formRes.json().values.language, 'en');
  assert.ok(formRes.json().yaml.includes('language: en'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].next.language, 'en');
  assert.deepEqual(calls[0].next.backfill, { enabled: true });

  // 2. YAML replace
  const yamlRes = createMockResponse();
  await handler({ method: 'POST', headers: json, body: { mode: 'yaml', yaml: 'language: en\ntimeoutMs: 30000\n' } }, yamlRes, owner);
  assert.equal(yamlRes.statusCode, 200);
  assert.equal(yamlRes.json().saved, true);
  assert.equal(yamlRes.json().restarted, true);
  assert.equal(yamlRes.json().values.timeoutMs, 30000);
  assert.deepEqual(calls[1].next, { language: 'en', timeoutMs: 30000 });

  // 3. YAML no-op skips write
  const yamlNoop = createMockResponse();
  await handler({ method: 'POST', headers: json, body: { mode: 'yaml', yaml: 'language: zh\n' } }, yamlNoop, owner);
  assert.equal(yamlNoop.statusCode, 200);
  assert.equal(yamlNoop.json().restarted, false);
  assert.equal(calls.length, 2);

  // 4. YAML syntax error returns 400 invalid-yaml
  const yamlBad = createMockResponse();
  await handler({ method: 'POST', headers: json, body: { mode: 'yaml', yaml: '\tbad: 1\n' } }, yamlBad, owner);
  assert.equal(yamlBad.statusCode, 400);
  assert.equal(yamlBad.json().code, 'invalid-yaml');

  // 5. Reset restores inherited bundle defaults
  const resetRes = createMockResponse();
  await handler({ method: 'POST', headers: json, body: { mode: 'reset' } }, resetRes, owner);
  assert.equal(resetRes.statusCode, 200);
  assert.equal(resetRes.json().saved, true);
  assert.equal(resetRes.json().restarted, true);
  assert.deepEqual(calls[2].next, inherited);
});

test('POST skips the write when nothing effective changes', async () => {
  let writes = 0;
  const { handler } = setup({ editor: { edit: async () => { writes += 1; } } });
  const res = createMockResponse();
  await handler({ method: 'POST', headers: json, body: { changes: { language: 'zh' } } }, res, owner);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().restarted, false);
  assert.equal(writes, 0, 'an unchanged form does not restart the plugin');
});

test('POST rejects bad content type, bad values and a profile without an editor', async () => {
  let writes = 0;
  const { handler } = setup({ editor: { edit: async () => { writes += 1; } } });
  const wrongType = createMockResponse();
  await handler({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }, wrongType, owner);
  assert.equal(wrongType.statusCode, 415);

  const invalid = createMockResponse();
  await handler({ method: 'POST', headers: json, body: { changes: { language: 'fr' } } }, invalid, owner);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, 'invalid-settings');
  assert.equal(writes, 0, 'an invalid form never reaches the profile file');

  const none = setup({});
  const noEditor = createMockResponse();
  await none.handler({ method: 'POST', headers: json, body: { changes: { language: 'en' } } }, noEditor, owner);
  assert.equal(noEditor.statusCode, 409);
  assert.equal(noEditor.json().code, 'editor-unavailable');
});

test('POST reports a higher-layer override and a failed save without leaking provider detail', async () => {
  const overridden = setup({ editor: { edit: async () => { throw new Error('Configuration for "x" is overridden by a home patch'); } } });
  const a = createMockResponse();
  await overridden.handler({ method: 'POST', headers: json, body: { changes: { language: 'en' } } }, a, owner);
  assert.equal(a.statusCode, 409);
  assert.equal(a.json().code, 'config-overridden');

  const failing = setup({ editor: { edit: async () => { throw Object.assign(new Error('secret /Users/x/path'), { code: 'EACCES' }); } } });
  const b = createMockResponse();
  await failing.handler({ method: 'POST', headers: json, body: { changes: { language: 'en' } } }, b, owner);
  assert.equal(b.statusCode, 500);
  assert.equal(b.json().category, 'EACCES');
  assert.doesNotMatch(JSON.stringify(b.json()), /secret|Users/u);

  const stale = setup({ editor: { edit: async (_entry, change) => change({ language: 'zh', topicMinChars: 50, topicMaxChars: 60 }, {}) } });
  const c = createMockResponse();
  await stale.handler({ method: 'POST', headers: json, body: { changes: { topicMaxChars: 30 } } }, c, owner);
  assert.equal(c.statusCode, 400);
  assert.equal(c.json().code, 'invalid-settings');
});

test('a second save while one is running is refused instead of queued', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { handler } = setup({ editor: { edit: () => gate } });
  const first = createMockResponse();
  const pending = handler({ method: 'POST', headers: json, body: { changes: { language: 'en' } } }, first, owner);
  const second = createMockResponse();
  await handler({ method: 'POST', headers: json, body: { changes: { language: 'en' } } }, second, owner);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().code, 'save-in-progress');
  release();
  await pending;
  assert.equal(first.statusCode, 200);
});
