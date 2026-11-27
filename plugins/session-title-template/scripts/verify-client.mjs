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

/** A React stand-in: `createElement` records shape; hooks are inert unless effect capture is active. */
let capturedEffects = null;
const reactStub = {
  createElement(type, props, ...children) {
    // Match real React's `props.children` shape: undefined for 0 children,
    // the single child directly (not an Array) for 1 child, and an Array for 2+.
    // Keeping this faithful catches bugs like `...children` on a single child.
    const normalizedChildren = children.length === 0
      ? undefined
      : children.length === 1
        ? children[0]
        : children;
    return { type, props: props ?? {}, children: normalizedChildren };
  },
  Fragment: Symbol('Fragment'),
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
  useEffect(fn) { if (capturedEffects !== null) capturedEffects.push(fn); },
  useMemo(factory) { return factory(); },
  useRef(value) { return { current: value }; },
};

/** Expand one component while capturing and running its mount `useEffect` callbacks once. */
function mountOnce(element) {
  const queue = [];
  capturedEffects = queue;
  let tree;
  try {
    tree = expand(element);
  } finally {
    capturedEffects = null;
  }
  const cleanups = [];
  for (const effect of queue) {
    const cleanup = effect();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  }
  return { tree, unmount: () => { for (const fn of cleanups) fn(); } };
}

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
  const { exported, pkg } = await loadClient();
  const { ctx, registrations, dictionaries, disposers, menus } = createContext();
  exported.apply(ctx);
  // Every resource is registered inside an effect, so unloading the plugin must
  // be able to run its cleanup.
  for (const { result, label } of disposers) {
    if (typeof result !== 'function') throw new Error(`effect ${label ?? '(unlabelled)'} returned no disposer`);
  }
  const owners = registrations.map(entry => entry.options.name).sort();
  const expected = [
    'contextMenu.icon', 'contextMenu.icon', 'contextMenu.icon', 'contextMenu.icon', 'contextMenu.icon',
    'conversation.chat.commandview',
    'plugins.bundle.config',
    'shell.overlay', 'shell.overlay',
    'sidebar.session.row.hover', 'sidebar.session.row.trailing',
  ];
  if (JSON.stringify(owners) !== JSON.stringify(expected)) {
    throw new Error(`unexpected slots: ${JSON.stringify(owners)}`);
  }
  const bundleConfig = registrations.find(entry => entry.options.name === 'plugins.bundle.config');
  if (bundleConfig?.options.key !== pkg.name) {
    throw new Error(`plugins.bundle.config must be keyed by package name ${pkg.name}, got ${bundleConfig?.options.key}`);
  }
  const iconKeys = registrations.filter(e => e.options.name === 'contextMenu.icon').map(e => e.options.key).sort();
  if (JSON.stringify(iconKeys) !== JSON.stringify([
    'session-title-template.auto', 'session-title-template.pin',
    'session-title-template.settings', 'session-title-template.status', 'session-title-template.title',
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
  if (zhKeys.includes('settings.model.note')) throw new Error('redundant paired-route settings.model.note should stay removed');
  if (zhKeys.includes('settings.types.note')) throw new Error('redundant settings.types.note should stay removed');
  if (zhKeys.includes('settings.types.provisional')) throw new Error('redundant settings.types.provisional button label should stay removed');
  if (/[（(]/u.test(String(dicts.zh['settings.types.colHint']))) throw new Error('zh colHint should not carry parenthetical notes');
  if (String(dicts.zh['settings.types.colProvisional']) === '临时') throw new Error('zh colProvisional should be a full column heading, not bare 临时');
  if (String(dicts.zh['settings.maxOutputTokens']) !== '输出词元上限') throw new Error('zh maxOutputTokens should use 词元 instead of Token');
  if (String(dicts.zh['yaml.subtitle']).includes('面向开发者')) throw new Error('yaml.subtitle should not carry 面向开发者 prefix');
  if (String(dicts.en['yaml.subtitle']).includes('For developers')) throw new Error('en yaml.subtitle should not carry For developers prefix');
});

check('the menu is one native submenu holding the four operations', async () => {
  const { exported } = await loadClient();
  const { ctx, menus } = createContext();
  exported.apply(ctx);
  const actions = menus[0].resolve({ sessionId: 'S1', displayTitle: '[1124][修复] 修复登录超时' }, new AbortController().signal);
  if (actions.length !== 1) throw new Error(`expected one top-level row, got ${actions.length}`);
  const [group] = actions;
  if (group.label !== 'menu.title') throw new Error(`top-level label should be menu.title, got ${group.label}`);
  if (group.icon?.key === undefined) throw new Error('the group needs an icon key to occupy the icon column');
  const ids = group.children.map(child => child.id);
  const expected = ['title.auto', 'title.pin', 'title.status', 'title.settings'];
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
    '探针结论：开发者角色正常，该端点能读到标题指令块',
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
  for (const expected of ['[{date}][{type}] {topic}', '~/.dsh/AGENTS.md', '[1124][修复] 修复登录超时', '开发者角色正常，该端点能读到标题指令块']) {
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

/** Minimal Response stand-in for the fetch stubs below. */
const reply = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });

const sampleTypes = [
  { key: '功能', hint: '新增能力', provisional: false },
  { key: '修复', hint: '排障纠错', provisional: false },
  { key: '探索', hint: '初步理解', provisional: true, maxRefinements: 4 },
];
const settingsValues = {
  template: '[{date}][{type}] {topic}',
  language: 'zh',
  timezone: 'Asia/Shanghai',
  dateFormat: 'MMDD',
  cjkSpacing: true,
  topicMinChars: 8,
  topicMaxChars: 20,
  fallbackType: '探索',
  types: sampleTypes,
  maxProvisionalRefinements: 4,
  provider: '',
  model: '',
  subagentProvider: '',
  subagentModel: '',
  fallbackProvider: '',
  fallbackModel: '',
  roleProbe: true,
  agentsInstructions: true,
  agentsInstructionsMaxBytes: 4096,
  backfill: false,
  maxInputBytes: 4096,
  maxOutputTokens: 4096,
  timeoutMs: 60000,
  retryAttempts: 3,
  retryDelayMs: 500,
};
const sampleModels = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
  },
];
const settingsOptions = {
  languages: ['zh', 'en'],
  types: ['功能', '修复', '探索'],
  defaultTypes: sampleTypes,
  models: sampleModels,
};
const sampleYaml = 'language: zh\n';
const sampleFullYaml = "template: '[{date}][{type}] {topic}'\nlanguage: zh\nmaxOutputTokens: 4096\n";

/** Mount the plugin with a scripted fetch and open the settings dialog. */
async function openSettingsDialog(handler) {
  const calls = [];
  const fetchStub = async (url, init = {}) => { calls.push({ url, init }); return handler(url, init, calls); };
  const { exported } = await loadClient({ fetch: fetchStub, setTimeout, clearTimeout });
  const { ctx, registrations, menus, notices } = createContext();
  exported.apply(ctx);
  const overlay = registrations.find(entry => entry.options.id === 'session-title-template.settings-dialog');
  if (overlay === undefined) throw new Error('settings dialog must register its own shell.overlay slot');
  const [group] = menus[0].resolve({ sessionId: 'S1', displayTitle: 'x' }, new AbortController().signal);
  const row = group.children.find(child => child.id === 'title.settings');
  const render = () => expand(overlay.component({}));
  const selectTab = (tabId) => {
    const tab = findElement(render(), node => node.props?.role === 'tab' && textOf(node).includes(`settings.tab.${tabId}`))[0];
    if (tab === undefined) throw new Error(`tab ${tabId} not found`);
    tab.props.onClick();
  };
  return { calls, overlay, row, notices, render, selectTab };
}

/** Mount the plugin-detail YAML editor registered in `plugins.bundle.config`. */
async function mountYamlEditor(handler) {
  const calls = [];
  const fetchStub = async (url, init = {}) => { calls.push({ url, init }); return handler(url, init, calls); };
  const { exported } = await loadClient({ fetch: fetchStub, setTimeout, clearTimeout });
  const { ctx, registrations } = createContext();
  exported.apply(ctx);
  const slot = registrations.find(entry => entry.options.name === 'plugins.bundle.config');
  if (slot === undefined) throw new Error('YAML editor must register in plugins.bundle.config');
  const mounted = mountOnce(slot.component({ view: 'page' }));
  await tick();
  return {
    calls,
    slot,
    render: () => expand(slot.component({ view: 'page' })),
    unmount: mounted.unmount,
  };
}

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));

check('naming settings opens from the menu, even on a cold session, and stays closed until invoked', async () => {
  const { overlay, row } = await openSettingsDialog(async () => reply(200, { editable: true, values: settingsValues, options: settingsOptions, yaml: sampleYaml, fullYaml: sampleFullYaml }));
  if (expand(overlay.component({})) !== null) throw new Error('settings dialog must stay closed before invocation');
  if (row.disabled === true) throw new Error('naming settings is a form about the plugin, not one session; it must stay enabled');
  if (row.icon?.key !== 'session-title-template.settings') throw new Error('naming settings needs its own icon');
});

check('naming settings loads into four tabs with live preview and Style A dirty-only reload notice', async () => {
  const { calls, row, render, selectTab } = await openSettingsDialog(async () => reply(200, {
    editable: true, values: settingsValues, options: settingsOptions, yaml: sampleYaml, fullYaml: sampleFullYaml,
  }));
  await row.run();
  if (calls[0].url !== 'session-title-template/settings') throw new Error(`unexpected route: ${calls[0].url}`);
  const tree = render();
  if (findElement(tree, node => node.props?.role === 'dialog').length !== 1) throw new Error('expected one dialog');
  const tabs = findElement(tree, node => node.props?.role === 'tab');
  if (tabs.length !== 4) throw new Error(`expected 4 tabs, got ${tabs.length}`);
  // Clean state must NOT show the Style A reload warning yet.
  if (textOf(tree).includes('settings.restartNote')) {
    throw new Error('Style A reload notice must stay hidden until a field is dirty');
  }
  const preview = findElement(tree, node => node.props?.['data-testid'] === 'settings-preview')[0];
  if (!preview || !textOf(preview).includes('[功能]')) {
    throw new Error(`live preview did not render formatted title: ${preview ? textOf(preview) : 'missing'}`);
  }
  const save = findElement(tree, node => node.type === 'button' && textOf(node).includes('settings.save'))[0];
  if (save?.props.disabled !== true) throw new Error('Save must be disabled until something changes');

  // The settings modal keeps one fixed frame across tabs and collapsible sections.
  const dialogStyle = findElement(tree, node => node.props?.role === 'dialog')[0]?.props?.style;
  if (typeof dialogStyle?.height !== 'string' || !dialogStyle.height.includes('736px')) {
    throw new Error(`settings modal should use a fixed height, got ${dialogStyle?.height}`);
  }
  if (dialogStyle?.maxHeight !== 'calc(100% - 48px)') {
    throw new Error(`settings modal should cap its fixed frame against the padded viewport, got ${dialogStyle?.maxHeight}`);
  }
  for (const tabId of ['format', 'types', 'models', 'behavior']) {
    selectTab(tabId);
    const tabTree = render();
    for (const control of [
      ...findElement(tabTree, node => node.type === 'select' || node.type === 'input'),
      ...findElement(tabTree, node => node.props?.role === 'switch'),
    ]) {
      if (typeof control.props['aria-label'] !== 'string' || control.props['aria-label'] === '') {
        throw new Error(`control on tab ${tabId} needs an accessible aria-label`);
      }
    }
  }
});

check('editing format fields updates live preview, reveals Style A reload notice, and saves only changed fields', async () => {
  const { calls, row, render } = await openSettingsDialog(async (url, init) => {
    if (init.method === 'POST') {
      return reply(200, {
        saved: true, restarted: true,
        values: { ...settingsValues, template: '({date}) {type}: {topic}', language: 'en', topicMaxChars: 30 },
        yaml: 'language: en\n', fullYaml: sampleFullYaml,
      });
    }
    return reply(200, { editable: true, values: settingsValues, options: settingsOptions, yaml: sampleYaml, fullYaml: sampleFullYaml });
  });
  await row.run();
  const change = (predicate, value) => {
    const control = findElement(render(), predicate)[0];
    if (control === undefined) throw new Error('control not found');
    control.props.onChange({ target: { value } });
  };
  change(node => node.type === 'input' && node.props['aria-label'] === 'settings.template', '({date}) {type}: {topic}');
  change(node => node.type === 'select' && node.props['aria-label'] === 'settings.language', 'en');
  change(node => node.type === 'input' && node.props['aria-label'] === 'settings.topicMax', '30');

  const dirtyTree = render();
  if (!textOf(dirtyTree).includes('settings.restartNote')) {
    throw new Error('Style A reload notice must appear once fields are dirty');
  }
  const preview = findElement(dirtyTree, node => node.props?.['data-testid'] === 'settings-preview')[0];
  if (!textOf(preview).includes('功能: settings.preview.sampleTopicEn')) {
    throw new Error(`live preview did not reflect updated template/language: ${textOf(preview)}`);
  }

  const saveButton = () => findElement(render(), node => node.type === 'button' && textOf(node).includes('settings.save'))[0];
  if (saveButton().props.disabled === true) throw new Error('Save must enable once a field differs');
  saveButton().props.onClick();
  await tick();
  const post = calls.find(call => call.init.method === 'POST');
  if (post === undefined) throw new Error('no POST was sent');
  const body = JSON.parse(post.init.body);
  if (JSON.stringify(body) !== JSON.stringify({ changes: { template: '({date}) {type}: {topic}', language: 'en', topicMaxChars: 30 } })) {
    throw new Error(`only the changed fields may be sent, got ${post.init.body}`);
  }
  if (!textOf(render()).includes('settings.saved')) throw new Error('success must be reported in the dialog');
  if (saveButton().props.disabled !== true) throw new Error('Save must disable again once the values are saved');
});

check('types tab keeps provisional status and refinement count inside each vocabulary row', async () => {
  const { calls, row, render, selectTab } = await openSettingsDialog(async (url, init) => {
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      return reply(200, { saved: true, restarted: true, values: { ...settingsValues, ...body.changes }, yaml: sampleYaml, fullYaml: sampleFullYaml });
    }
    return reply(200, { editable: true, values: settingsValues, options: settingsOptions, yaml: sampleYaml, fullYaml: sampleFullYaml });
  });
  await row.run();
  selectTab('types');
  const collapsed = render();
  if (findElement(collapsed, node => node.type === 'input' && node.props['aria-label'] === 'settings.types.keyAria:{"index":1}').length !== 0) {
    throw new Error('vocabulary table should start collapsed');
  }
  const toggle = findElement(collapsed, node => node.type === 'button' && node.props['aria-expanded'] === false && node.props['aria-label'] === 'settings.group.types')[0];
  if (toggle === undefined) throw new Error('vocabulary card should expose one collapsed toggle');
  toggle.props.onClick();
  const open = render();
  const provisional = findElement(open, node => node.props?.role === 'switch' && String(node.props['aria-label']).includes('settings.types.provisionalAria'));
  if (provisional.length !== 3) throw new Error(`expected one provisional switch per row, got ${provisional.length}`);
  const count = findElement(open, node => node.type === 'input' && String(node.props['aria-label']).includes('settings.types.countAria'));
  if (count.length !== 3) throw new Error(`expected one refinement input per row, got ${count.length}`);
  const firstCount = count[2];
  firstCount.props.onChange({ target: { value: '6' } });
  findElement(render(), node => node.type === 'button' && textOf(node).includes('settings.save'))[0].props.onClick();
  await tick();
  const post = calls.find(call => call.init.method === 'POST');
  const body = JSON.parse(post.init.body);
  if (body.changes.types?.find((entry) => entry.key === '探索')?.maxRefinements !== 6) {
    throw new Error(`per-type refinement count was not saved: ${post.init.body}`);
  }
});

check('models tab merges main, subagent, and fallback routes into Generation card and supports catalog + manual entry', async () => {
  const { calls, row, render, selectTab } = await openSettingsDialog(async (url, init) => {
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      return reply(200, { saved: true, restarted: true, values: { ...settingsValues, ...body.changes }, yaml: sampleYaml, fullYaml: sampleFullYaml });
    }
    return reply(200, { editable: true, values: settingsValues, options: settingsOptions, yaml: sampleYaml, fullYaml: sampleFullYaml });
  });
  await row.run();
  selectTab('models');
  const tree = render();
  if (textOf(tree).includes('settings.model.note')) {
    throw new Error('redundant paired-route helper note must not render');
  }
  if (!textOf(tree).includes('settings.group.models')) {
    throw new Error('models tab must render unified Generation section');
  }
  const primarySelect = findElement(tree, node => node.type === 'select' && node.props['aria-label'] === 'settings.primaryRoute')[0];
  const subagentSelect = findElement(tree, node => node.type === 'select' && node.props['aria-label'] === 'settings.subagentRoute')[0];
  const fallbackSelect = findElement(tree, node => node.type === 'select' && node.props['aria-label'] === 'settings.fallbackRoute')[0];
  if (!primarySelect || !subagentSelect || !fallbackSelect) {
    throw new Error('main, subagent, and fallback model selectors must all render');
  }

  // Choose DeepSeek Chat for main agent and DeepSeek Reasoner for subagent from catalog.
  primarySelect.props.onChange({ target: { value: 'deepseek\u0000deepseek-chat' } });
  subagentSelect.props.onChange({ target: { value: 'deepseek\u0000deepseek-reasoner' } });
  // Switch fallback route to manual custom entry and type provider/model.
  fallbackSelect.props.onChange({ target: { value: '__custom__' } });
  const fbProvider = findElement(render(), node => node.type === 'input' && node.props['aria-label'] === 'settings.fallbackProvider')[0];
  const fbModel = findElement(render(), node => node.type === 'input' && node.props['aria-label'] === 'settings.fallbackModel')[0];
  if (!fbProvider || !fbModel) throw new Error('selecting custom route must reveal manual Provider and Model inputs');
  fbProvider.props.onChange({ target: { value: 'custom-p' } });
  fbModel.props.onChange({ target: { value: 'custom-m' } });

  findElement(render(), node => node.type === 'button' && textOf(node).includes('settings.save'))[0].props.onClick();
  await tick();
  const post = calls.find(call => call.init.method === 'POST');
  const body = JSON.parse(post.init.body);
  if (JSON.stringify(body.changes) !== JSON.stringify({
    provider: 'deepseek',
    model: 'deepseek-chat',
    subagentProvider: 'deepseek',
    subagentModel: 'deepseek-reasoner',
    fallbackProvider: 'custom-p',
    fallbackModel: 'custom-m',
  })) {
    throw new Error(`unexpected model changes payload: ${post.init.body}`);
  }
});

check('behavior tab expands advanced parameters and surfaces numeric/Host validation cleanly', async () => {
  const { calls, row, render, selectTab } = await openSettingsDialog(async (url, init) => {
    if (init.method === 'POST') {
      return reply(400, { code: 'invalid-settings', message: 'session-title-template: config.topicMaxChars must not be smaller than topicMinChars' });
    }
    return reply(200, { editable: true, values: settingsValues, options: settingsOptions, yaml: sampleYaml, fullYaml: sampleFullYaml });
  });
  await row.run();
  selectTab('behavior');
  if (findElement(render(), node => node.type === 'input' && node.props['aria-label'] === 'settings.timeoutMs').length !== 0) {
    throw new Error('advanced parameters should start collapsed');
  }
  const disclosure = findElement(render(), node => node.type === 'button' && node.props['aria-expanded'] === false)[0];
  disclosure.props.onClick();
  const timeoutField = findElement(render(), node => node.type === 'input' && node.props['aria-label'] === 'settings.timeoutMs')[0];
  if (timeoutField === undefined) throw new Error('expanding advanced section must reveal timeoutMs');
  timeoutField.props.onChange({ target: { value: 'abc' } });

  // Jump back to format tab and press Save: client should reject without POST and navigate back to behavior tab.
  selectTab('format');
  const save = () => findElement(render(), node => node.type === 'button' && textOf(node).includes('settings.save'))[0];
  const reset = () => findElement(render(), node => node.type === 'button' && textOf(node).includes('settings.reset'))[0];
  if (save().props.disabled === true) throw new Error('Save must stay enabled on an invalid numeric draft');
  if (reset().props.disabled === true) throw new Error('Revert must enable on an invalid numeric draft');
  save().props.onClick();
  await tick();
  if (calls.some(call => call.init.method === 'POST')) throw new Error('an invalid numeric value must not reach the Host');
  if (!textOf(render()).includes('settings.invalidNumber')) throw new Error('the numeric error must be shown');
  if (findElement(render(), node => node.type === 'input' && node.props['aria-label'] === 'settings.timeoutMs').length !== 1) {
    throw new Error('saving with an invalid advanced field must switch back to behavior tab and keep advanced expanded');
  }

  // Revert, then trigger a Host 400 validation message.
  reset().props.onClick();
  selectTab('format');
  const maxField = findElement(render(), node => node.type === 'input' && node.props['aria-label'] === 'settings.topicMax')[0];
  maxField.props.onChange({ target: { value: '3' } });
  save().props.onClick();
  await tick();
  const text = textOf(render());
  if (!text.includes('settings.invalid') || !text.includes('topicMaxChars must not be smaller')) {
    throw new Error(`the Host message must be shown without its plugin prefix: ${text}`);
  }
  if (text.includes('session-title-template: config')) throw new Error('the plugin prefix must be stripped from the Host message');
});

check('a profile that cannot save keeps the form read-only and an unreachable route says to restart', async () => {
  const readOnly = await openSettingsDialog(async () => reply(200, {
    editable: false, reason: 'editor-unavailable', values: settingsValues, options: settingsOptions, yaml: sampleYaml, fullYaml: sampleFullYaml,
  }));
  await readOnly.row.run();
  const tree = readOnly.render();
  if (!textOf(tree).includes('settings.editorUnavailable')) throw new Error('the read-only reason must be explained');
  const save = findElement(tree, node => node.type === 'button' && textOf(node).includes('settings.save'))[0];
  if (save.props.disabled !== true) throw new Error('Save must stay disabled without an editor');
  for (const tabId of ['format', 'types', 'models', 'behavior']) {
    readOnly.selectTab(tabId);
    for (const toggle of findElement(readOnly.render(), node => node.type === 'button' && node.props['aria-expanded'] === false)) {
      toggle.props.onClick();
    }
    const tabTree = readOnly.render();
    for (const control of [
      ...findElement(tabTree, node => node.type === 'input' || node.type === 'select'),
      ...findElement(tabTree, node => node.props?.role === 'switch' || node.props?.role === 'checkbox'),
    ]) {
      if (control.props.disabled !== true) throw new Error(`read-only form must disable control ${control.props['aria-label']}`);
    }
  }

  const missing = await openSettingsDialog(async () => ({ ok: false, status: 404, json: async () => { throw new Error('not json'); } }));
  await missing.row.run();
  if (!textOf(missing.render()).includes('settings.needsReload')) throw new Error('a missing route must tell the user to restart DSH');
});

check('a save whose reply is lost to the plugin restart is verified by deep-equal read-back', async () => {
  let reads = 0;
  const updatedTypes = [
    { key: '功能', hint: '新增能力', provisional: false },
    { key: '修复', hint: '排障纠错', provisional: false },
    { key: '探索', hint: '已更新说明', provisional: true },
  ];
  const { row, render, selectTab } = await openSettingsDialog(async (url, init) => {
    if (init.method === 'POST') throw new TypeError('network connection lost');
    reads += 1;
    return reply(200, {
      editable: true,
      values: reads === 1 ? settingsValues : { ...settingsValues, types: updatedTypes },
      options: settingsOptions,
      yaml: sampleYaml,
      fullYaml: sampleFullYaml,
    });
  });
  await row.run();
  selectTab('types');
  findElement(render(), node => node.type === 'button' && node.props['aria-expanded'] === false && node.props['aria-label'] === 'settings.group.types')[0].props.onClick();
  findElement(render(), node => node.type === 'input' && node.props['aria-label'] === 'settings.types.hintAria:{"index":3}')[0]
    .props.onChange({ target: { value: '已更新说明' } });
  findElement(render(), node => node.type === 'button' && textOf(node).includes('settings.save'))[0].props.onClick();
  await tick(1400);
  if (!textOf(render()).includes('settings.saved')) throw new Error('a restart-dropped reply with deep-equal types must count as saved');
});

check('naming settings aligns control width tiers, vocabulary columns, and modal gutters', async () => {
  const { row, render, selectTab } = await openSettingsDialog(async () => reply(200, {
    editable: true, values: settingsValues, options: settingsOptions, yaml: sampleYaml, fullYaml: sampleFullYaml,
  }));
  await row.run();
  const formatTree = render();
  const dialog = findElement(formatTree, node => node.props?.role === 'dialog')[0];
  if (dialog?.props?.style?.width !== 'min(620px, 100%)') {
    throw new Error(`expected 620px settings modal, got ${dialog?.props?.style?.width}`);
  }
  const guttered = findElement(dialog, node => node.type === 'div' && node.props?.style?.scrollbarGutter === 'stable');
  if (guttered.length !== 3) {
    throw new Error(`expected subHeader, body, and footer to share scrollbarGutter: stable, got ${guttered.length}`);
  }
  const reset = findElement(formatTree, node => node.type === 'button' && textOf(node).includes('settings.reset'))[0];
  const save = findElement(formatTree, node => node.type === 'button' && textOf(node).includes('settings.save'))[0];
  if (reset?.props?.style?.minWidth !== 68 || save?.props?.style?.minWidth !== 68) {
    throw new Error(`footer buttons must share 68px minWidth, got ${reset?.props?.style?.minWidth} / ${save?.props?.style?.minWidth}`);
  }

  selectTab('types');
  findElement(render(), node => node.type === 'button' && node.props['aria-expanded'] === false && node.props['aria-label'] === 'settings.group.types')[0].props.onClick();
  const typesTree = render();
  const tableRows = findElement(typesTree, node => node.type === 'div' && node.props?.style?.gridTemplateColumns === '120px minmax(0, 1fr) 44px 48px 28px');
  if (tableRows.length !== sampleTypes.length + 1) {
    throw new Error(`expected header + ${sampleTypes.length} vocabulary rows on unified 120/1fr/44/48/28 grid, got ${tableRows.length}`);
  }
  const countInputs = findElement(typesTree, node => node.type === 'input' && String(node.props['aria-label']).includes('settings.types.countAria'));
  if (countInputs[0]?.props?.placeholder !== '–' || countInputs[2]?.props?.placeholder !== '4') {
    throw new Error(`disabled rounds should show en-dash placeholder while active rows show 4, got ${countInputs[0]?.props?.placeholder} / ${countInputs[2]?.props?.placeholder}`);
  }
  const addBtn = findElement(typesTree, node => node.type === 'button' && textOf(node).includes('settings.types.add'))[0];
  if (addBtn?.props?.style?.width !== 120 || addBtn?.props?.style?.height !== 28) {
    throw new Error(`add type button must match 120x28 tier, got ${addBtn?.props?.style?.width}x${addBtn?.props?.style?.height}`);
  }

  selectTab('behavior');
  const behaviorTree = render();
  const uiLangRow = findElement(behaviorTree, node => node.type === 'div'
    && node.props?.style?.gridTemplateColumns === 'minmax(0, 1fr) minmax(0, 120px)'
    && findElement(node, child => child.type === 'select' && child.props['aria-label'] === 'settings.uiLanguage').length === 1);
  if (uiLangRow.length !== 1) {
    throw new Error('uiLanguage on behavior tab must align with the 120px column tier');
  }
});

check('a /title card summarises the report and offers copy plus an expandable body', async () => {
  const { exported } = await loadClient();
  const { ctx, registrations } = createContext();
  exported.apply(ctx);
  const view = registrations.find(entry => entry.options.name === 'conversation.chat.commandview');
  if (view === undefined) throw new Error('the title command must own a conversation.chat.commandview row');
  if (view.options.key !== 'title') throw new Error(`the row must key on the title command, got ${view.options.key}`);
  const report = [
    '命名规则：内置规则 + 1 个补充来源',
    '内置规则',
    '  标题格式    [{date}][{type}] {topic}',
    '当前标题',
    '  [1126][优化] 命名插件补写配置与界面调整',
    '  来源：自动生成',
    '  状态：未固定',
    '探针结论：开发者角色正常，该端点能读到标题指令块',
  ].join('\n');
  const node = { kind: 'command', name: 'title', args: 'status', outcome: { kind: 'success', text: report } };
  const collapsed = expand(view.component({ node }));
  const summary = findElement(collapsed, n => n.type === 'span'
    && n.props?.title === '[1126][优化] 命名插件补写配置与界面调整');
  if (summary.length !== 1) throw new Error('the collapsed row must summarise with the title line, not the whole report');
  if (findElement(collapsed, n => n.type === 'pre').length !== 0) {
    throw new Error('the report body must start collapsed');
  }
  if (textOf(collapsed).trim().startsWith('titlestatus') === false) {
    throw new Error('the row must name the command and its verb chip');
  }
  const copy = findElement(collapsed, n => n.type === 'button' && n.props['aria-label'] === 'command.copy')[0];
  if (copy === undefined) throw new Error('the row must offer a copy action');
  // Copying without a DOM must fail quietly instead of throwing into the transcript.
  await copy.props.onClick({ stopPropagation() {} });
  const oneLine = expand(view.component({
    node: { ...node, args: 'pin 示例标题', outcome: { kind: 'success', text: '已固定：示例标题\n自动命名不再覆盖；用 /title auto 可恢复自动命名。' } },
  }));
  // Every settled row can reveal the command's own output, not only the long ones.
  const header = findElement(oneLine, n => n.type === 'div' && typeof n.props?.onClick === 'function')[0];
  if (header === undefined) throw new Error('every settled row must offer the expand toggle');
  // The verb the invocation used is the chip, so four operations never read alike.
  if (!textOf(oneLine).includes('pin')) throw new Error('a pin invocation must show its own verb chip');
  if (!textOf(oneLine).includes('示例标题')) throw new Error('a pin result summarises the pinned title without the lead-in');
  if (textOf(oneLine).includes('已固定：')) {
    throw new Error('the summary repeats a lead-in the verb chip already states');
  }
  const running = expand(view.component({ node: { ...node, args: 'refresh', outcome: null } }));
  if (findElement(running, n => n.type === 'div' && typeof n.props?.onClick === 'function').length !== 0) {
    throw new Error('a running row has no output yet, so it must not offer the toggle');
  }
});

check('plugin detail YAML editor loads, expands full config, validates syntax, saves and resets cleanly', async () => {
  let activeYaml = sampleYaml;
  const { calls, render, unmount } = await mountYamlEditor(async (url, init) => {
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.mode === 'reset') {
        activeYaml = '{}\n';
        return reply(200, { saved: true, restarted: true, values: settingsValues, yaml: activeYaml, fullYaml: sampleFullYaml });
      }
      if (body.yaml.includes('bad:')) {
        return reply(400, { code: 'invalid-yaml', message: 'YAML syntax error on line 2: unexpected token' });
      }
      activeYaml = body.yaml;
      return reply(200, { saved: true, restarted: true, values: settingsValues, yaml: activeYaml, fullYaml: sampleFullYaml });
    }
    return reply(200, { editable: true, values: settingsValues, options: settingsOptions, yaml: activeYaml, fullYaml: sampleFullYaml });
  });

  const textarea = () => findElement(render(), node => node.type === 'textarea')[0];
  const button = (labelKey) => findElement(render(), node => node.type === 'button' && textOf(node).includes(labelKey))[0];

  if (textarea()?.props.value !== sampleYaml) throw new Error(`expected initial YAML, got: ${textarea()?.props.value}`);
  if (textOf(render()).includes('settings.restartNote')) throw new Error('YAML editor footer must stay silent until edited');
  if (button('yaml.save').props.disabled !== true) throw new Error('Save YAML must be disabled before editing');

  // Expand full config populates textarea and reveals Style A reload reminder.
  button('yaml.expandFull').props.onClick();
  if (textarea().props.value !== sampleFullYaml) throw new Error('Expand full config must load fullYaml');
  if (!textOf(render()).includes('settings.restartNote')) throw new Error('Style A reload notice must appear when YAML is dirty');

  // Syntax error from Host surfaces cleanly.
  textarea().props.onChange({ target: { value: 'language: zh\nbad: "unterminated\n' } });
  button('yaml.save').props.onClick();
  await tick();
  if (!textOf(render()).includes('YAML syntax error on line 2')) {
    throw new Error(`YAML syntax error was not surfaced: ${textOf(render())}`);
  }

  // Valid YAML save sends mode: 'yaml' and disables Save again.
  textarea().props.onChange({ target: { value: 'language: en\n' } });
  button('yaml.save').props.onClick();
  await tick();
  const yamlPost = calls.filter(c => c.init.method === 'POST').at(-1);
  if (JSON.parse(yamlPost.init.body).mode !== 'yaml') throw new Error(`expected yaml save mode, got ${yamlPost.init.body}`);
  if (!textOf(render()).includes('settings.saved')) throw new Error('YAML save success must be reported');
  if (button('yaml.save').props.disabled !== true) throw new Error('Save YAML must disable again after saving');

  // Inline confirm reset sends mode: 'reset'.
  button('yaml.resetDefaults').props.onClick();
  const confirm = button('yaml.confirmReset');
  if (confirm === undefined) throw new Error('clicking Reset defaults must ask for inline confirmation');
  confirm.props.onClick();
  await tick();
  const resetPost = calls.filter(c => c.init.method === 'POST').at(-1);
  if (JSON.parse(resetPost.init.body).mode !== 'reset') throw new Error(`expected reset mode, got ${resetPost.init.body}`);
  if (!textOf(render()).includes('yaml.resetDone')) throw new Error('YAML reset success must be reported');
  unmount();
});

check('plugin detail YAML editor stays read-only when profile has no configEditor', async () => {
  const { render, unmount } = await mountYamlEditor(async () => reply(200, {
    editable: false, reason: 'editor-unavailable', values: settingsValues, options: settingsOptions, yaml: sampleYaml, fullYaml: sampleFullYaml,
  }));
  const tree = render();
  if (!textOf(tree).includes('settings.editorUnavailable')) throw new Error('read-only YAML editor must explain why saving is disabled');
  const textarea = findElement(tree, node => node.type === 'textarea')[0];
  if (textarea?.props.disabled !== true) throw new Error('read-only YAML editor must disable textarea');
  const save = findElement(tree, node => node.type === 'button' && textOf(node).includes('yaml.save'))[0];
  if (save?.props.disabled !== true) throw new Error('read-only YAML editor must disable Save YAML');
  unmount();
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
