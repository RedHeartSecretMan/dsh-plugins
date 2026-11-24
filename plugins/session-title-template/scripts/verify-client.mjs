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
async function loadClient() {
  const source = await readFile(join(root, 'client.js'), 'utf8');
  const loaded = [];
  const window = {
    __ModuleLoader__: { load(definition) { loaded.push(definition); } },
  };
  const sandbox = {
    window,
    require(specifier) {
      if (specifier === 'react') return reactStub;
      throw new Error(`client.js must not require ${specifier}: a profile-installed plugin cannot resolve Harness packages`);
    },
    console,
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
    },
    remote: { commands: { execute: async () => ({ ok: true, value: undefined }) } },
  };
  return { ctx, registrations, dictionaries, disposers };
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

check('apply registers the three slots and the dictionaries', async () => {
  const { exported } = await loadClient();
  const { ctx, registrations, dictionaries, disposers } = createContext();
  exported.apply(ctx);
  // Every resource is registered inside an effect, so unloading the plugin must
  // be able to run its cleanup.
  for (const { result, label } of disposers) {
    if (typeof result !== 'function') throw new Error(`effect ${label ?? '(unlabelled)'} returned no disposer`);
  }
  const owners = registrations.map(entry => entry.options.name).sort();
  const expected = ['sidebar.session.row.hover', 'sidebar.session.row.trailing', 'sidebar.workspaces.session.menu.item'];
  if (JSON.stringify(owners) !== JSON.stringify(expected)) {
    throw new Error(`unexpected slots: ${JSON.stringify(owners)}`);
  }
  if (dictionaries.length !== 1) throw new Error('expected one locale registration');
  const { dicts } = dictionaries[0];
  const zhKeys = Object.keys(dicts.zh ?? {}).sort();
  const enKeys = Object.keys(dicts.en ?? {}).sort();
  if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) throw new Error('zh and en dictionaries must declare the same keys');
  if (zhKeys.length === 0) throw new Error('dictionaries are empty');
});

check('the menu renders four localized actions', async () => {
  const { exported } = await loadClient();
  const { ctx, registrations } = createContext();
  exported.apply(ctx);
  const menu = registrations.find(entry => entry.options.name === 'sidebar.workspaces.session.menu.item');
  const text = textOf(render(menu, {}));
  for (const key of ['menu.refresh', 'menu.pin', 'menu.auto', 'menu.status']) {
    if (!text.includes(key)) throw new Error(`menu is missing ${key}`);
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
  const { ctx, registrations } = createContext();
  exported.apply(ctx);
  const menu = registrations.find(entry => entry.options.name === 'sidebar.workspaces.session.menu.item');
  // Invoke the pin action the way a click would, and confirm it reached the
  // reference-based rename (the only path that also works for a cold session).
  // `apply` closes over the context it was given, so the recording rename is
  // installed on that same object rather than passed as a prop.
  let renamed;
  ctx.sessions = {
    using: async (_id, _options, operation) => operation({
      binding: { session: { rename: async title => { renamed = title; return { ok: true, value: { title, seq: 1 } }; } } },
    }),
  };
  const tree = render(menu, {});
  const buttons = findElement(tree, node => node.type === 'button');
  const pin = buttons.find(button => String(textOf(button.children)).includes('menu.pin'));
  if (pin === undefined) throw new Error('pin action not found in the menu');
  await pin.props.onClick();
  if (renamed === undefined) throw new Error('pin did not call the reference-based rename');
  if (renamed !== '[1124][修复] 修复登录超时') throw new Error(`pin sent the wrong title: ${renamed}`);
});

check('the hover section names the title source', async () => {
  const { exported } = await loadClient();
  const { ctx, registrations } = createContext();
  exported.apply(ctx);
  const hover = registrations.find(entry => entry.options.name === 'sidebar.session.row.hover');
  const text = textOf(render(hover, {}));
  if (!text.includes('source.provider')) throw new Error(`hover must name the source, got: ${text}`);
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
