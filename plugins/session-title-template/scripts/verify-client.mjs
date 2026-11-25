#!/usr/bin/env node
/**
 * Load `client.js` the way the Web carrier does, so a broken factory is caught
 * before a person installs the bundle.
 *
 * The carrier evaluates the file as a classic script that calls
 * `window.__ModuleLoader__.load({ id, factory })` and then runs the exported
 * Cordis plugin's `apply`. This verifier reproduces both steps with a minimal
 * React stand-in and a recording slot/locale/remote surface. It checks the shape
 * of the plugin, its slot registrations, its dictionaries and one render of each
 * component; it does not check visual output.
 *
 * Usage: node scripts/verify-client.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** A React stand-in: `createElement` records shape; hooks are inert. */
const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() };
  },
  Fragment: Symbol('Fragment'),
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
  useEffect() {},
  useMemo(factory) { return factory(); },
  useRef(value) { return { current: value }; },
};

/** Run `client.js` against a recording loader and return the plugin it exports. */
async function loadClient(extraGlobals = {}) {
  const source = await readFile(join(root, 'client.js'), 'utf8');
  const loaded = [];
  const window = {
    __ModuleLoader__: { load(definition) { loaded.push(definition); } },
  };
  const sandbox = {
    window,
    require(specifier) {
      if (specifier === 'react') return reactStub;
      if (specifier === 'react-dom') return { createPortal: (node) => node };
      throw new Error(`client.js must not require ${specifier}: a profile-installed plugin cannot resolve Harness packages`);
    },
    console,
    ...extraGlobals,
  };
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  if (loaded.length !== 1) throw new Error(`expected one module registration, got ${loaded.length}`);
  const definition = loaded[0];
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (definition.id !== pkg.name) {
    throw new Error(`module id ${JSON.stringify(definition.id)} must equal the package name ${JSON.stringify(pkg.name)}`);
  }
  const exported = definition.factory(sandbox.require);
  return { definition, exported, pkg };
}

/** A recording plugin context covering only what `apply` touches. */
function createContext() {
  const registrations = [];
  const dictionaries = [];
  const disposers = [];
  const menus = [];
  const notices = [];
  const ctx = {
    effect(setup, label) { const result = setup(); disposers.push({ result, label }); return result; },
    locale: {
      register(namespace, dicts) { dictionaries.push({ namespace, dicts }); return () => {}; },
      bind() { return (key, vars) => (vars === undefined ? key : `${key}:${JSON.stringify(vars)}`); },
    },
    slots: {
      inject(owner, callback) { callback(); return () => {}; },
      register(options, component) { registrations.push({ options, component }); return () => {}; },
    },
    // Only members the real Client face exposes may be called. `rename` lives on
    // a Session reference, not on `ctx.sessions`, so an accidental
    // `ctx.sessions.rename(...)` must fail here rather than in the GUI.
    sessions: {
      using: async (_sessionId, _options, operation) => operation({
        binding: { session: { rename: async () => ({ ok: true, value: { title: 'x', seq: 1 } }) } },
      }),
      retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 1 }) }),
    },
    contextMenus: {
      register(contribution) { menus.push(contribution); return () => {}; },
      notify(text, success) { notices.push({ text, success }); },
    },
    remote: { commands: { execute: async () => ({ ok: true, value: undefined }) } },
  };
  return { ctx, registrations, dictionaries, disposers, menus, notices };
}

/** Collect every string the component tree would render. */
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node.type === 'function') return textOf(node.type({ ...node.props, children: node.children }));
  return textOf(node.children ?? []);
}

/** Props a slot supplies to every occupant. */
const slotProps = {
  useSessions: selector => selector({
    byId: { S1: { displayTitle: '[1124][修复] 修复登录超时', projectionValues: { sessionTitleState: { title: '[1124][修复] 修复登录超时', source: 'provider', pinned: false } } } },
  }),
  useSessionRetainInfo: () => 1,
  useMenuOpenState: () => [true, () => {}],
};

/**
 * Render one registered component the way React would.
 *
 * A registration may return an element instead of host nodes, so the tree is
 * expanded until only host elements remain — that is the shape a test can
 * assert on without a real renderer.
 */
function render(registration, props) {
  return expand(registration.component({
    sessionId: 'S1',
    displayTitle: '[1124][修复] 修复登录超时',
    ...slotProps,
    ...props,
  }));
}

/** Replace every component element with the tree its function returns. */
function expand(node) {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== 'object' || typeof node.type !== 'function') {
    return typeof node === 'object' && node.children !== undefined
      ? { ...node, children: expand(node.children) }
      : node;
  }
  return expand(node.type({ ...node.props, children: node.children }));
}

/** Flatten a rendered element tree into a list of every node. */
function flatten(node, found = []) {
  if (node === null || node === undefined) return found;
  if (Array.isArray(node)) { for (const child of node) flatten(child, found); return found; }
  if (typeof node !== 'object') return found;
  found.push(node);
  flatten(node.children, found);
  return found;
}

/** Every element type a rendered tree uses, for shape assertions. */
function findElement(node, predicate, found = []) {
  if (node === null || node === undefined) return found;
  if (Array.isArray(node)) { for (const child of node) findElement(child, predicate, found); return found; }
  if (typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  findElement(node.children, predicate, found);
  return found;
}

const checks = [];
const check = (name, run) => checks.push({ name, run });

check('client.js registers one module whose id is the package name', async () => {
  const { definition, pkg } = await loadClient();
  if (definition.id !== pkg.name) throw new Error('id mismatch');
});

check('the exported plugin declares the services it uses', async () => {
  const { exported } = await loadClient();
  for (const service of ['slots', 'sessions', 'locale', 'remote', 'remote.commands']) {
    if (!exported.inject.includes(service)) throw new Error(`missing injection: ${service}`);
  }
  if (typeof exported.apply !== 'function') throw new Error('apply must be a function');
});

check('apply registers the row slots, the native menu, its icons and the dictionaries', async () => {
  const { exported } = await loadClient();
  const { ctx, registrations, dictionaries, disposers, menus } = createContext();
  exported.apply(ctx);
  // Every resource is registered inside an effect, so unloading the plugin must
  // be able to run its cleanup.
  for (const { result, label } of disposers) {
    if (typeof result !== 'function') throw new Error(`effect ${label ?? '(unlabelled)'} returned no disposer`);
  }
  const owners = registrations.map(entry => entry.options.name).sort();
  const expected = ['contextMenu.icon', 'contextMenu.icon', 'contextMenu.icon', 'contextMenu.icon', 'shell.overlay', 'sidebar.session.row.hover', 'sidebar.session.row.trailing'];
  if (JSON.stringify(owners) !== JSON.stringify(expected)) {
    throw new Error(`unexpected slots: ${JSON.stringify(owners)}`);
  }
  const iconKeys = registrations.filter(e => e.options.name === 'contextMenu.icon').map(e => e.options.key).sort();
  if (JSON.stringify(iconKeys) !== JSON.stringify([
    'session-title-template.auto', 'session-title-template.pin',
    'session-title-template.status', 'session-title-template.title',
  ])) {
    throw new Error(`unexpected icon keys: ${JSON.stringify(iconKeys)}`);
  }
  // The menu is a native contextMenus contribution, not the legacy slot.
  if (menus.length !== 1) throw new Error(`expected one native menu contribution, got ${menus.length}`);
  if (menus[0].target !== 'session') throw new Error('the menu must target the session family');
  if (typeof menus[0].observe !== 'function') throw new Error('the menu must declare observe() so locale and session state updates refresh it');
  if (dictionaries.length !== 1) throw new Error('expected one locale registration');
  const { dicts } = dictionaries[0];
  const zhKeys = Object.keys(dicts.zh ?? {}).sort();
  const enKeys = Object.keys(dicts.en ?? {}).sort();
  if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) throw new Error('zh and en dictionaries must declare the same keys');
  if (zhKeys.length === 0) throw new Error('dictionaries are empty');
});

check('the menu is one native submenu holding the three operations', async () => {
  const { exported } = await loadClient();
  const { ctx, menus } = createContext();
  exported.apply(ctx);
  const actions = menus[0].resolve({ sessionId: 'S1', displayTitle: '[1124][修复] 修复登录超时' }, new AbortController().signal);
  if (actions.length !== 1) throw new Error(`expected one top-level row, got ${actions.length}`);
  const [group] = actions;
  if (group.label !== 'menu.title') throw new Error(`top-level label should be menu.title, got ${group.label}`);
  if (group.icon?.key === undefined) throw new Error('the group needs an icon key to occupy the icon column');
  const ids = group.children.map(child => child.id);
  const expected = ['title.auto', 'title.pin', 'title.status'];
  if (JSON.stringify(ids) !== JSON.stringify(expected)) throw new Error(`unexpected children: ${JSON.stringify(ids)}`);
  if (group.children[0].icon?.key !== 'session-title-template.auto') {
    throw new Error(`title.auto must use the sparkle icon, got: ${group.children[0].icon?.key}`);
  }
  for (const child of group.children) {
    if (child.icon?.key === undefined) throw new Error(`${child.id} has no icon key`);
    if (typeof child.label !== 'string') throw new Error(`${child.id} has no label key`);
  }
});

check('the trailing icon renders for a known title state', async () => {
  const { exported } = await loadClient();
  const { ctx, registrations } = createContext();
  exported.apply(ctx);
  const trailing = registrations.find(entry => entry.options.name === 'sidebar.session.row.trailing');
  const tree = render(trailing, {});
  if (tree === null || tree === undefined) throw new Error('an icon should render for a provider title');
  const label = tree.props?.['aria-label'] ?? tree.props?.title;
  if (typeof label !== 'string' || label === '') throw new Error('the icon needs an accessible label');
});

check('the trailing icon renders nothing when the Host projects no state', async () => {
  const { exported } = await loadClient();
  const { ctx, registrations } = createContext();
  exported.apply(ctx);
  const trailing = registrations.find(entry => entry.options.name === 'sidebar.session.row.trailing');
  const tree = render(trailing, { useSessions: selector => selector({ byId: { S1: { projectionValues: {} } } }) });
  if (tree !== null && tree !== undefined) throw new Error('absence must render nothing, not a guessed icon');
});

check('pinning uses the Session reference path, not a phantom sessions.rename', async () => {
  const { exported } = await loadClient();
  const { ctx, menus, notices } = createContext();
  exported.apply(ctx);
  let renamed;
  ctx.sessions = {
    ...ctx.sessions,
    using: async (_id, _options, operation) => operation({
      binding: { session: { rename: async title => { renamed = title; return { ok: true, value: { title, seq: 1 } }; } } },
    }),
  };
  const [group] = menus[0].resolve({ sessionId: 'S1', displayTitle: '[1124][修复] 修复登录超时' }, new AbortController().signal);
  const pin = group.children.find(child => child.id === 'title.pin');
  await pin.run();
  if (renamed !== '[1124][修复] 修复登录超时') throw new Error(`pin sent the wrong title: ${renamed}`);
  if (notices.length !== 1) throw new Error('pin must report its outcome through the menu notice');
});

check('the live-only rows are disabled on a cold session and say why', async () => {
  const { exported } = await loadClient();
  const { ctx, menus } = createContext();
  exported.apply(ctx);
  // A cold session reports no retained reference, which is what the menu reads.
  ctx.sessions = { ...ctx.sessions, retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 0 }) }) };
  const [group] = menus[0].resolve({ sessionId: 'S1', displayTitle: 'x' }, new AbortController().signal);
  const byId = Object.fromEntries(group.children.map(child => [child.id, child]));
  for (const id of ['title.auto', 'title.status']) {
    if (byId[id].disabled !== true) throw new Error(`${id} must be disabled on a cold session`);
    if (byId[id].run !== undefined) throw new Error(`${id} must not expose a runnable action`);
    if (!String(byId[id].label).includes('menu.needsOpen')) throw new Error(`${id} must explain why it is unavailable`);
  }
  // Pinning resumes the session, so it stays available.
  if (byId['title.pin'].disabled === true) throw new Error('pin must stay available on a cold session');
  if (typeof byId['title.pin'].run !== 'function') throw new Error('pin must stay runnable');
});

check('the submenu parent does not reuse the built-in Rename icon', async () => {
  const { exported } = await loadClient();
  const { ctx, menus } = createContext();
  exported.apply(ctx);
  const [group] = menus[0].resolve({ sessionId: 'S1', displayTitle: 'x' }, new AbortController().signal);
  // The built-in Rename row is drawn directly above this one and uses
  // `workspace.rename`; sharing that key made the two rows look like the same
  // command.
  if (group.icon?.key === 'workspace.rename') {
    throw new Error('the parent must not reuse the Rename pencil');
  }
  if (group.icon?.key !== 'session-title-template.title') {
    throw new Error(`unexpected parent icon: ${group.icon?.key}`);
  }
});

check('pinning the title uses its own glyph instead of the Pin Session pushpin', async () => {
  const { exported } = await loadClient();
  const { ctx, menus, registrations } = createContext();
  exported.apply(ctx);
  const [group] = menus[0].resolve({ sessionId: 'S1', displayTitle: 'x' }, new AbortController().signal);
  const pinAction = group.children.find(child => child.id === 'title.pin');
  // The built-in Pin Session action and row indicator both use a pushpin
  // (`workspace.pin` / `workspace.unpin`). Reusing that glyph made "title
  // pinned" look identical to "session pinned to top" in the sidebar.
  if (pinAction.icon?.key === 'workspace.pin' || pinAction.icon?.key === 'workspace.unpin') {
    throw new Error('title.pin must not reuse the built-in Pin Session pushpin');
  }
  if (pinAction.icon?.key !== 'session-title-template.pin') {
    throw new Error(`unexpected pin action icon: ${pinAction.icon?.key}`);
  }
  const menuIcon = registrations.find(entry => entry.options.name === 'contextMenu.icon' && entry.options.key === 'session-title-template.pin');
  const trailing = registrations.find(entry => entry.options.name === 'sidebar.session.row.trailing');
  const pinnedRow = render(trailing, {
    useSessions: selector => selector({
      byId: { S1: { displayTitle: 'x', projectionValues: { sessionTitleState: { title: 'x', source: 'user', pinned: true } } } },
    }),
  });
  const shapeOf = (tree) => flatten(tree)
    .filter(n => n.type === 'path' || n.type === 'circle')
    .map(n => (n.type === 'path' ? ['path', n.props.d] : ['circle', n.props.cx, n.props.cy, n.props.r]));
  const menuShapes = shapeOf(expand(menuIcon.component({})));
  const rowShapes = shapeOf(pinnedRow);
  if (JSON.stringify(rowShapes) !== JSON.stringify(menuShapes)) {
    throw new Error('the pinned-title row icon must share the same glyph as title.pin');
  }
});

check('every custom glyph draws its full geometry', async () => {
  const { exported } = await loadClient();
  const { ctx, registrations } = createContext();
  exported.apply(ctx);
  const icons = registrations.filter(entry => entry.options.name === 'contextMenu.icon');
  if (icons.length === 0) throw new Error('no icon registrations');
  for (const icon of icons) {
    // Render through the module's own glyph helper by invoking the component.
    const tree = expand(icon.component({}));
    if (tree === null || typeof tree !== 'object') throw new Error(`${icon.options.key} rendered nothing`);
    const drawn = flatten(tree).filter(node => node.type === 'path' || node.type === 'circle');
    if (drawn.length === 0) throw new Error(`${icon.options.key} draws no geometry`);
    // A glyph reduced to its paths loses every <circle>; the eye glyph relies
    // on a circle for its pupil.
    if (icon.options.key === 'session-title-template.status' && !drawn.some(n => n.type === 'circle')) {
      throw new Error(`${icon.options.key} lost its circle`);
    }
    for (const node of drawn) {
      if (node.type === 'path' && (typeof node.props.d !== 'string' || node.props.d === '')) {
        throw new Error(`${icon.options.key} has an empty path`);
      }
      if (node.type === 'circle' && (node.props.r === undefined || node.props.cx === undefined)) {
        throw new Error(`${icon.options.key} has an incomplete circle`);
      }
    }
  }
});

check('the hover section uses hovercard tokens and renders each title state cleanly', async () => {
  const { exported } = await loadClient();
  const { ctx, registrations } = createContext();
  exported.apply(ctx);
  const hover = registrations.find(entry => entry.options.name === 'sidebar.session.row.hover');

  const autoTree = render(hover, {});
  const autoText = textOf(autoTree);
  if (!autoText.includes('hover.auto') || !autoText.includes('hover.autoNote')) {
    throw new Error(`hover must label provider titles with aligned note, got: ${autoText}`);
  }
  const styled = flatten(autoTree).filter(node => typeof node.props?.style?.color === 'string');
  if (!styled.some(node => node.props.style.color.includes('--dsw-alias-hovercard-label-'))) {
    throw new Error('hover text must use hovercard label tokens so it stays legible on the dark surface');
  }

  const pinnedTree = render(hover, {
    useSessions: selector => selector({
      byId: { S1: { displayTitle: 'x', projectionValues: { sessionTitleState: { title: 'x', source: 'user', pinned: true } } } },
    }),
  });
  const pinnedText = textOf(pinnedTree);
  if (!pinnedText.includes('hover.pinned') || !pinnedText.includes('hover.pinnedNote')) {
    throw new Error(`pinned hover must show pinned label and note, got: ${pinnedText}`);
  }

  const emptyTree = render(hover, {
    useSessions: selector => selector({
      byId: { S1: { displayTitle: 'x', projectionValues: { sessionTitleState: { title: null, source: null, pinned: false } } } },
    }),
  });
  if (emptyTree !== null) throw new Error('unknown/empty title state must not render a noisy hover row');
});

check('viewing status opens a structured shell.overlay modal instead of dumping into a toast', async () => {
  const { exported } = await loadClient();
  const { ctx, registrations, menus, notices } = createContext();
  const sampleReport = [
    '命名规则：内置规则 + 1 个补充来源',
    '内置规则',
    '  标题格式    [{date}][{type}] {topic}',
    '  日期来源    会话创建时间 · MMDD · Asia/Shanghai',
    '  类型词表    功能、修复、文档',
    '  主题长度    8—20 字宽',
    '补充规则（1）',
    '  ~/.dsh/AGENTS.md',
    '当前标题',
    '  [1124][修复] 修复登录超时',
    '  来源：自动生成',
    '  状态：未固定',
    '探针结论：该端点能读到指令块，角色正常',
  ].join('\n');
  ctx.remote = {
    commands: {
      execute: async () => ({ ok: true, value: { result: { kind: 'success', text: sampleReport } } }),
    },
  };
  exported.apply(ctx);
  const overlay = registrations.find(entry => entry.options.name === 'shell.overlay');
  if (overlay === undefined) throw new Error('status modal must register in shell.overlay');
  if (expand(overlay.component({})) !== null) throw new Error('status modal must stay closed before invocation');

  const [group] = menus[0].resolve({ sessionId: 'S1', displayTitle: '[1124][修复] 修复登录超时' }, new AbortController().signal);
  const statusAction = group.children.find(child => child.id === 'title.status');
  await statusAction.run();

  if (notices.length !== 0) {
    throw new Error('viewing status must open the modal dialog instead of pushing a multi-line toast');
  }
  const tree = expand(overlay.component({}));
  const dialogs = findElement(tree, node => node.props?.role === 'dialog');
  if (dialogs.length !== 1) throw new Error(`expected one modal dialog, got ${dialogs.length}`);
  const buttons = findElement(dialogs[0], node => node.type === 'button');
  if (buttons.length !== 1) throw new Error(`status dialog should keep one close control, got ${buttons.length}`);
  const text = textOf(tree);
  for (const expected of ['[{date}][{type}] {topic}', '~/.dsh/AGENTS.md', '[1124][修复] 修复登录超时', '该端点能读到指令块，角色正常']) {
    if (!text.includes(expected)) throw new Error(`status dialog missed expected content: ${expected}`);
  }
});

check('viewing status prefers the read-only HTTP route so no command event mutates the session', async () => {
  const fetched = [];
  const sampleSnapshot = {
    summary: '内置规则 + 1 个补充来源',
    builtin: {
      template: '[{date}][{type}] {topic}',
      dateFormat: 'MMDD',
      timezone: 'Asia/Shanghai',
      types: ['功能', '修复'],
      topicMinChars: 8,
      topicMaxChars: 20,
    },
    supplemental: { count: 1, sources: ['~/.dsh/AGENTS.md'] },
    title: { value: '[1125][修复] 修复抖动', source: 'provider', pinned: false },
    lastFailure: null,
    probe: { verdict: 'supported', checkedAt: 1700000000000 },
  };
  const { exported } = await loadClient({
    fetch: async (url) => {
      fetched.push(url);
      return { ok: true, status: 200, json: async () => ({ snapshot: sampleSnapshot, text: 'unused' }) };
    },
  });
  const { ctx, registrations, menus } = createContext();
  let commandCalls = 0;
  ctx.remote = {
    commands: {
      execute: async () => { commandCalls += 1; return { ok: true, value: { result: { kind: 'success', text: '' } } }; },
    },
  };
  exported.apply(ctx);
  const overlay = registrations.find(entry => entry.options.name === 'shell.overlay');
  const [group] = menus[0].resolve({ sessionId: 'S1', displayTitle: '[1125][修复] 修复抖动' }, new AbortController().signal);
  await group.children.find(child => child.id === 'title.status').run();

  if (fetched.length !== 1 || fetched[0] !== 'session-title-template/status?sessionId=S1') {
    throw new Error(`expected read-only status route fetch, got: ${JSON.stringify(fetched)}`);
  }
  if (commandCalls !== 0) {
    throw new Error('when the read-only route succeeds, /title status must not be executed into the session log');
  }
  const tree = expand(overlay.component({}));
  if (!textOf(tree).includes('[1125][修复] 修复抖动')) {
    throw new Error('status dialog did not render payload from the read-only route');
  }
});

check('structured snapshot renders purely in English under the en locale with no Chinese bleed-through', async () => {
  const sampleSnapshot = {
    summary: '内置规则 + 1 个补充来源',
    builtin: {
      template: '[{date}] {type}: {topic}',
      dateFormat: 'YYYY-MM-DD',
      timezone: 'UTC',
      types: ['feat', 'fix'],
      topicMinChars: 8,
      topicMaxChars: 20,
    },
    supplemental: { count: 1, sources: ['~/.dsh/AGENTS.md'] },
    title: { value: '[2026-11-25] fix: resolve login timeout', source: 'fallback', pinned: false },
    lastFailure: { category: 'timeout', route: 'local/fast', attempt: 2, at: Date.UTC(2026, 10, 25, 10, 15) },
    probe: { verdict: 'unsupported', checkedAt: Date.UTC(2026, 10, 25, 10, 0) },
  };
  const { exported } = await loadClient({
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ snapshot: sampleSnapshot, text: '中文回退文本' }) }),
  });
  const { ctx, registrations, menus } = createContext();
  let enDict = {};
  ctx.locale = {
    register(_ns, dicts) { enDict = dicts.en; return () => {}; },
    bind() {
      return (key, vars = {}) => String(enDict[key] ?? key).replace(/\{(\w+)\}/gu, (_m, k) => String(vars[k] ?? ''));
    },
  };
  exported.apply(ctx);
  const overlay = registrations.find(entry => entry.options.name === 'shell.overlay');
  const [group] = menus[0].resolve({ sessionId: 'S1', displayTitle: sampleSnapshot.title.value }, new AbortController().signal);
  await group.children.find(child => child.id === 'title.status').run();
  const text = textOf(expand(overlay.component({})));
  if (/[\p{Script=Han}（）：]/u.test(text)) {
    throw new Error(`English status dialog leaked Chinese text or punctuation: ${text}`);
  }
  for (const expected of ['Session creation time', 'timeout', 'timeoutMs', 'Endpoint dropped the instruction block']) {
    if (!text.includes(expected)) throw new Error(`English status dialog missed expected content: ${expected}`);
  }
});

check('cold sessions can inspect status via HTTP while keeping Auto-generate disabled', async () => {
  const { exported } = await loadClient({
    fetch: async () => ({
      ok: true, status: 200,
      json: async () => ({
        live: false,
        snapshot: {
          builtin: { template: '[{date}][{type}] {topic}' },
          supplemental: { count: 0, sources: [] },
          title: { value: '[1125][文档] 冷会话标题', source: 'provider', pinned: false },
          lastFailure: null,
          probe: null,
        },
      }),
    }),
  });
  const { ctx, registrations, menus } = createContext();
  ctx.sessions = { ...ctx.sessions, retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 0 }) }) };
  exported.apply(ctx);
  const [group] = menus[0].resolve({ sessionId: 'cold-1', displayTitle: '[1125][文档] 冷会话标题' }, new AbortController().signal);
  const byId = Object.fromEntries(group.children.map(child => [child.id, child]));
  if (byId['title.auto'].disabled !== true) throw new Error('title.auto must stay disabled on a cold session');
  if (byId['title.status'].disabled === true) throw new Error('title.status should be enabled on a cold session when fetch is available');
  await byId['title.status'].run();
  const overlay = registrations.find(entry => entry.options.name === 'shell.overlay');
  if (!textOf(expand(overlay.component({}))).includes('[1125][文档] 冷会话标题')) {
    throw new Error('cold session status modal did not render the persisted title');
  }
});

check('structured HTTP status errors do not fall back to /title status', async () => {
  const { exported } = await loadClient({
    fetch: async () => ({
      ok: false, status: 500,
      json: async () => ({ code: 'status-failed', message: 'Failed' }),
    }),
  });
  const { ctx, registrations, menus } = createContext();
  let commandCalls = 0;
  ctx.remote = {
    commands: {
      execute: async () => { commandCalls += 1; return { ok: true, value: { result: { kind: 'success', text: '' } } }; },
    },
  };
  exported.apply(ctx);
  const [group] = menus[0].resolve({ sessionId: 'S1', displayTitle: 'x' }, new AbortController().signal);
  await group.children.find(child => child.id === 'title.status').run();
  if (commandCalls !== 0) throw new Error('structured HTTP 500 from our route must not fall back to /title status');
  const overlay = registrations.find(entry => entry.options.name === 'shell.overlay');
  if (!textOf(expand(overlay.component({}))).includes('menu.statusFailed')) {
    throw new Error('structured HTTP error should render in the status dialog');
  }
});

check('Auto-generate prefers the silent POST refresh route and surfaces detailed errors directly', async () => {
  const calls = [];
  let mode = 'ok';
  const { exported } = await loadClient({
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (mode === 'empty') {
        return { ok: false, status: 409, json: async () => ({ code: 'no-eligible-message' }) };
      }
      return { ok: true, status: 200, json: async () => ({ title: '[1125][优化] 新生成标题', source: 'provider' }) };
    },
  });
  const { ctx, menus, notices } = createContext();
  let commandCalls = 0;
  ctx.remote = {
    commands: {
      execute: async () => { commandCalls += 1; return { ok: true, value: { result: { kind: 'success', text: '' } } }; },
    },
  };
  exported.apply(ctx);
  const [group] = menus[0].resolve({ sessionId: 'S1', displayTitle: 'old' }, new AbortController().signal);
  await group.children.find(child => child.id === 'title.auto').run();

  if (calls.length !== 1 || calls[0].url !== 'session-title-template/refresh' || calls[0].init?.method !== 'POST') {
    throw new Error(`expected POST refresh route, got: ${JSON.stringify(calls)}`);
  }
  if (commandCalls !== 0) throw new Error('silent refresh route should avoid executing /title refresh');
  if (notices.length !== 2 || notices[0].text !== 'menu.autoRunning' || !notices[1].text.includes('menu.autoDone')) {
    throw new Error(`unexpected refresh notices: ${JSON.stringify(notices)}`);
  }

  mode = 'empty';
  await group.children.find(child => child.id === 'title.auto').run();
  const lastNotice = notices.at(-1);
  if (lastNotice.success !== false || lastNotice.text !== 'menu.noEligibleMessage') {
    throw new Error(`expected direct error notice for 409 no-eligible-message, got: ${JSON.stringify(lastNotice)}`);
  }
  if (commandCalls !== 0) throw new Error('structured 409 from refresh route must not fall back to /title refresh');
});

check('Pin current disables when already pinned or when the session has no title yet', async () => {
  const { exported } = await loadClient();
  const { ctx, menus } = createContext();
  let state = { title: '[1125][文档] 已固定标题', source: 'user', pinned: true };
  ctx.sessions = {
    ...ctx.sessions,
    list: {
      getSnapshot: () => ({ byId: { S1: { projectionValues: { sessionTitleState: state } } } }),
      subscribe: () => () => {},
    },
  };
  exported.apply(ctx);
  let [group] = menus[0].resolve({ sessionId: 'S1', displayTitle: '已固定标题' }, new AbortController().signal);
  let pin = group.children.find(child => child.id === 'title.pin');
  if (pin.disabled !== true || !pin.label.includes('menu.alreadyPinned')) {
    throw new Error(`pinned session should disable title.pin: ${JSON.stringify(pin)}`);
  }

  state = { title: null, source: null, pinned: false };
  [group] = menus[0].resolve({ sessionId: 'S1', displayTitle: '未命名会话' }, new AbortController().signal);
  pin = group.children.find(child => child.id === 'title.pin');
  if (pin.disabled !== true || !pin.label.includes('menu.noTitleYet')) {
    throw new Error(`untitled session should disable title.pin instead of pinning placeholder: ${JSON.stringify(pin)}`);
  }
});

check('closing or replacing a status request aborts the prior fetch and fallback parser keeps titles starting with 来源：', async () => {
  const signals = [];
  let resolveFirst;
  const { exported } = await loadClient({
    AbortController,
    fetch: (_url, init) => {
      signals.push(init?.signal);
      if (signals.length === 1) return new Promise(resolve => { resolveFirst = resolve; });
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({
          text: [
            '命名规则：内置规则',
            '当前标题',
            '  来源：排查网关转发问题',
            '  来源：自动生成',
            '  状态：未固定',
          ].join('\n'),
        }),
      });
    },
  });
  const { ctx, registrations, menus } = createContext();
  exported.apply(ctx);
  const overlay = registrations.find(entry => entry.options.name === 'shell.overlay');
  const [group] = menus[0].resolve({ sessionId: 'S1', displayTitle: 'fallback' }, new AbortController().signal);
  const first = group.children.find(child => child.id === 'title.status').run();
  const second = group.children.find(child => child.id === 'title.status').run();
  await second;
  if (signals[0]?.aborted !== true) throw new Error('starting a newer status request must abort the previous fetch');
  resolveFirst({ ok: true, status: 200, json: async () => ({ text: '' }) });
  await first;
  const text = textOf(expand(overlay.component({})));
  if (!text.includes('来源：排查网关转发问题')) {
    throw new Error(`fallback parser misclassified title starting with 来源：: ${text}`);
  }
});

let failed = 0;
for (const { name, run } of checks) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(`     ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} client checks passed`);
process.exit(failed === 0 ? 0 : 1);
