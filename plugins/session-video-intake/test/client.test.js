import assert from 'node:assert/strict';
import { File as NodeFile } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');

/** DOM propagation model: window capture runs before document/core bubbling. */
function browser({ consume = true, busy = false } = {}) {
  const hostPaths = new WeakMap();
  let byteReads = 0;
  class File extends NodeFile {
    get path() { return hostPaths.get(this) || ''; }
    arrayBuffer() {
      byteReads += 1;
      return super.arrayBuffer();
    }
  }
  class Event {
    constructor(type, options = {}) {
      Object.assign(this, {
        type, bubbles: false, cancelable: false, defaultPrevented: false,
        isTrusted: false, target: null, stopped: false, immediate: false,
      }, options);
    }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    stopPropagation() { this.stopped = true; }
    stopImmediatePropagation() { this.immediate = this.stopped = true; }
  }
  class DragEvent extends Event {}
  class ClipboardEvent extends Event {}

  const events = [];
  class Target {
    constructor(parent = null) {
      this.parent = parent;
      this.listeners = [];
    }
    addEventListener(type, handler, capture = false) {
      this.listeners.push({ type, handler, capture: capture === true });
    }
    removeEventListener(type, handler, capture = false) {
      this.listeners = this.listeners.filter((item) => item.type !== type
        || item.handler !== handler || item.capture !== (capture === true));
    }
    dispatchEvent(event) {
      assert.equal(event.target, null, 'each synthetic event must be new');
      event.target = this;
      events.push(event);
      assert.ok(events.length < 100, 'synthetic event loop');
      const ancestors = [];
      for (let parent = this.parent; parent; parent = parent.parent) ancestors.push(parent);
      const invoke = (target, capture) => {
        event.currentTarget = target;
        for (const entry of [...target.listeners]) {
          if (entry.type === event.type && entry.capture === capture) entry.handler(event);
          if (event.immediate) break;
        }
      };
      for (const ancestor of [...ancestors].reverse()) {
        invoke(ancestor, true);
        if (event.stopped) return !event.defaultPrevented;
      }
      invoke(this, true);
      if (!event.immediate) invoke(this, false);
      if (event.bubbles && !event.stopped) {
        for (const ancestor of ancestors) {
          invoke(ancestor, false);
          if (event.stopped) break;
        }
      }
      return !event.defaultPrevented;
    }
  }
  class Element extends Target {
    constructor(tag = 'div', classes = '', attributes = {}) {
      super();
      this.tagName = tag.toUpperCase();
      this.classes = new Set(classes.split(' ').filter(Boolean));
      this.classList = { contains: (name) => this.classes.has(name) };
      this.attributes = attributes;
      this.children = [];
    }
    get parentElement() { return this.parent instanceof Element ? this.parent : null; }
    get previousElementSibling() {
      return this.parentElement?.children[this.parentElement.children.indexOf(this) - 1] || null;
    }
    get nextElementSibling() {
      return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null;
    }
    append(...children) {
      for (const child of children) {
        child.parent = this;
        this.children.push(child);
      }
    }
    matches(selector) {
      const tag = selector.match(/^[a-z]+/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) {
        if (!this.classes.has(name)) return false;
      }
      for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
        if (!(name in this.attributes) || (value !== undefined && this.attributes[name] !== value)) return false;
      }
      return true;
    }
    closest(selector) {
      for (let element = this; element instanceof Element; element = element.parentElement) {
        if (element.matches(selector)) return element;
      }
      return null;
    }
  }
  class HTMLInputElement extends Element {
    constructor() {
      super('input');
      Object.assign(this, {
        type: 'file', accept: '', multiple: true, hidden: true,
        disabled: false, files: [], value: 'C:\\fakepath\\picked.mp4',
      });
    }
  }
  class DataTransfer {
    constructor() {
      this.items = [];
      this.items.add = (file) => {
        const item = { kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => null };
        this.items.push(item);
        return item;
      };
      this.text = new Map();
    }
    get files() { return this.items.filter((item) => item.kind === 'file').map((item) => item.getAsFile()); }
    get types() { return [...(this.files.length ? ['Files'] : []), ...this.text.keys()]; }
    setData(type, value) { this.text.set(type, value); }
    getData(type) { return this.text.get(type) || ''; }
  }

  const window = new Target();
  const document = new Target(window);
  const body = new Element('body');
  body.parent = document;
  document.body = body;
  // A plugin adding DOM fails immediately; fixtures use Element directly.
  document.createElement = () => { throw new Error('plugin must not create DOM'); };
  const card = new Element('div', 'JZLxKW_card', { 'data-composer-card': 'true' });
  const row = new Element('div', 'JZLxKW_row');
  const tools = new Element('div', 'JZLxKW_tools');
  const commands = new Element('button', 'JZLxKW_add');
  const picker = new HTMLInputElement();
  const modes = new Element('div', 'JZLxKW_modes');
  const editor = new Element('div', 'JZLxKW_input', {
    'data-composer-input': 'true', 'data-lexical-editor': 'true',
  });
  body.append(card);
  card.append(editor, row);
  row.append(tools);
  tools.append(commands, picker, modes);

  const intakes = [];
  const uploads = [];
  const references = [];
  const texts = [];
  const notices = [];
  const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  // Mirrors 0.2.1-rc.3 ui-conversation addFiles (:20142) and createDrafts
  // (:4751): host-path non-images become references; pathless Files upload.
  const addFiles = (files, directories = new Set()) => {
    if (busy) { notices.push('attachment.dropBlocked'); return; }
    intakes.push([...files]);
    for (const file of files) {
      const directory = directories.has(file);
      const path = window.__DSH_HOST_PATHS__.pathFor(file);
      if (path === '' || (!directory && imageTypes.has(file.type))) {
        uploads.push({ kind: imageTypes.has(file.type) ? 'image' : 'file', file });
      } else references.push({ file, path, directory });
    }
  };
  window.__DSH_HOST_PATHS__ = { pathFor: (file) => file.path };
  const directoriesFor = (transfer) => new Set(transfer.items
    .filter((item) => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory)
    .map((item) => item.getAsFile()));
  // Real installDocumentDropEvents checks "Files", never isTrusted.
  document.addEventListener('drop', (event) => {
    if (!consume || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    addFiles([...event.dataTransfer.files], directoriesFor(event.dataTransfer));
  });
  // Mirrors Lexical's file + plain text paste intake, on the actual editor.
  editor.addEventListener('paste', (event) => {
    if (!consume || !event.clipboardData) return;
    const transfer = event.clipboardData;
    if (transfer.files.length) addFiles([...transfer.files], directoriesFor(transfer));
    const text = transfer.getData('text/plain');
    if (text) texts.push(text);
    if (text || transfer.files.length) event.preventDefault();
  });
  // React's delegated change path sees the event only after window capture.
  document.addEventListener('change', (event) => {
    if (event.target !== picker) return;
    const files = [...picker.files];
    picker.value = '';
    if (files.length) addFiles(files);
  });

  let registration;
  window.__ModuleLoader__ = { load: (entry) => { registration = entry; } };
  const errors = [];
  const context = vm.createContext({
    window, document, File, Element, HTMLInputElement, DataTransfer, DragEvent, ClipboardEvent,
    console: { error: (...args) => errors.push(args) },
  });
  vm.runInContext(clientSource, context, { filename: 'session-video-intake/client.js' });
  const disposers = [];
  const plugin = () => registration.factory(() => { throw new Error('unexpected dependency'); });
  const apply = () => plugin().apply({ effect: (setup) => { disposers.push(setup()); } });
  const dispose = () => { for (const cleanup of disposers.splice(0).reverse()) cleanup(); };
  const transferFor = (files) => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    return transfer;
  };
  const nativeFile = (name, type, bytes = [0, 1, 2, 255], path = `/native/${name}`) => {
    const file = new File([new Uint8Array(bytes)], name, { type, lastModified: 1700000000123 });
    if (path) hostPaths.set(file, path);
    return file;
  };
  const drop = (files, target = editor) => {
    const event = new DragEvent('drop', {
      bubbles: true, cancelable: true, isTrusted: true, dataTransfer: transferFor(files),
    });
    target.dispatchEvent(event);
    return event;
  };
  const paste = (files, target = editor, text = '') => {
    const transfer = transferFor(files);
    if (text) {
      transfer.setData('text/plain', text);
      transfer.setData('text/html', `<b>${text}</b>`);
    }
    const event = new ClipboardEvent('paste', {
      bubbles: true, cancelable: true, isTrusted: true, clipboardData: transfer,
    });
    target.dispatchEvent(event);
    return event;
  };
  const change = (files, input = picker) => {
    input.files = files;
    const event = new Event('change', { bubbles: true, cancelable: false, isTrusted: true });
    input.dispatchEvent(event);
    return event;
  };
  return {
    window, document, body, card, tools, picker, editor, Element, HTMLInputElement,
    Event, DragEvent, DataTransfer, context, errors, events, intakes, uploads, references,
    texts, notices, nativeFile, transferFor, drop, paste, change, apply, dispose,
    registration: () => registration, byteReads: () => byteReads,
  };
}

const bytes = async (file) => Buffer.from(await NodeFile.prototype.arrayBuffer.call(file));

async function assertVideoCopy(original, copied) {
  assert.notEqual(copied, original);
  assert.equal(original.path, `/native/${original.name}`);
  assert.equal(copied.path, '', 'Electron path bridge must see a pathless File');
  assert.equal(copied.name, original.name);
  assert.equal(copied.type, original.type);
  assert.equal(copied.lastModified, original.lastModified);
  assert.deepEqual(await bytes(copied), await bytes(original));
}

test('lazy module has no listeners until apply; mixed drop keeps bytes, order and native routing', async () => {
  const b = browser();
  assert.equal(b.registration().id, '@redheartsecretman/session-video-intake');
  assert.equal(b.window.listeners.length, 0);
  b.apply();
  const image = b.nativeFile('before.png', 'image/png');
  const first = b.nativeFile('first.mp4', 'video/mp4', [255, 0, 128, 13, 10, 0, 47]);
  const ordinary = b.nativeFile('middle.pdf', 'application/pdf');
  const second = b.nativeFile('last.WEBM', '', [9, 8, 0, 7]);
  const originals = [image, first, ordinary, second];
  const originalEvent = b.drop(originals);
  assert.equal(b.intakes.length, 1);
  const received = b.intakes[0];
  assert.deepEqual(received.map((file) => file.name), originals.map((file) => file.name));
  assert.equal(received[0], image);
  assert.equal(received[2], ordinary);
  await assertVideoCopy(first, received[1]);
  await assertVideoCopy(second, received[3]);
  assert.deepEqual(b.uploads.map(({ kind }) => kind), ['image', 'file', 'file']);
  assert.deepEqual(b.references.map(({ file }) => file), [ordinary]);
  assert.equal(b.events.filter((event) => event.type === 'drop').length, 2);
  assert.equal(b.events[1].isTrusted, false, 'core consumed a synthetic event');
  assert.equal(originalEvent.immediate, true);
  assert.equal(b.byteReads(), 0, 'client must wrap Blob bytes without reading them');
  assert.equal(b.errors.length, 0);
});

test('ordinary images/files and text-only transfers keep their original events and identity', () => {
  const b = browser();
  b.apply();
  const image = b.nativeFile('looks-like-video.mp4', 'image/png');
  const file = b.nativeFile('readme.txt', 'text/plain');
  const original = b.drop([image, file]);
  assert.equal(b.events.length, 1);
  assert.equal(original.immediate, false);
  assert.deepEqual(b.intakes[0], [image, file]);
  const event = new b.DragEvent('drop', {
    bubbles: true, cancelable: true, dataTransfer: b.transferFor([]),
  });
  b.body.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(b.events.length, 2);
});

test('composer paste keeps all files in order and preserves plain text and HTML', async () => {
  const b = browser();
  b.apply();
  const first = b.nativeFile('a.txt', 'text/plain');
  const video = b.nativeFile('clip.webm', 'video/webm');
  const last = b.nativeFile('z.png', 'image/png');
  const original = b.paste([first, video, last], b.editor, 'caption');
  assert.equal(b.intakes.length, 1);
  assert.equal(b.intakes[0][0], first);
  assert.equal(b.intakes[0][2], last);
  await assertVideoCopy(video, b.intakes[0][1]);
  assert.deepEqual(b.texts, ['caption']);
  assert.equal(b.events[1].clipboardData.getData('text/html'), '<b>caption</b>');
  assert.deepEqual(b.events.map(({ type }) => type), ['paste', 'paste']);
  assert.equal(original.immediate, true);
  assert.equal(b.byteReads(), 0);
});

test('paste outside the composer or into another plugin overlay is untouched', () => {
  const b = browser();
  b.apply();
  const video = b.nativeFile('clip.mp4', 'video/mp4');
  const external = new b.Element('textarea');
  b.body.append(external);
  const outside = b.paste([video], external);
  const overlay = new b.Element('div', '', { 'data-composer-overlay': 'true' });
  const nested = new b.Element('div', '', {
    'data-composer-input': 'true', 'data-lexical-editor': 'true',
  });
  b.card.append(overlay);
  overlay.append(nested);
  const inside = b.paste([video], nested);
  assert.equal(outside.immediate, false);
  assert.equal(inside.immediate, false);
  assert.equal(b.events.length, 2);
  assert.equal(b.intakes.length, 0);
});

test('only the verified native composer picker routes through drop without accept mutations', async () => {
  const b = browser();
  b.apply();
  const image = b.nativeFile('before.jpg', 'image/jpeg');
  const video = b.nativeFile('picked.mp4', 'video/mp4');
  const ordinary = b.nativeFile('after.pdf', 'application/pdf');
  const original = b.change([image, video, ordinary]);
  assert.equal(original.immediate, true);
  assert.equal(b.picker.value, '');
  assert.equal(b.picker.accept, '');
  assert.equal(b.picker.hidden, true);
  assert.equal(b.picker.multiple, true);
  assert.equal(b.intakes.length, 1);
  assert.equal(b.intakes[0][0], image);
  assert.equal(b.intakes[0][2], ordinary);
  await assertVideoCopy(video, b.intakes[0][1]);
  assert.deepEqual(b.events.map(({ type }) => type), ['change', 'drop']);
});

test('unrelated and slot file inputs never match the native picker', () => {
  const b = browser();
  b.apply();
  const video = b.nativeFile('clip.mp4', 'video/mp4');
  const external = new b.HTMLInputElement();
  const slotInput = new b.HTMLInputElement();
  const nestedSlot = new b.HTMLInputElement();
  const slotWrapper = new b.Element();
  b.body.append(external);
  b.tools.append(slotInput, slotWrapper);
  slotWrapper.append(nestedSlot);
  for (const input of [external, slotInput, nestedSlot]) {
    const original = b.change([video], input);
    assert.equal(original.immediate, false);
    assert.equal(input.value, 'C:\\fakepath\\picked.mp4');
    assert.equal(input.accept, '');
  }
  assert.equal(b.events.length, 3);
  assert.equal(b.intakes.length, 0);
});

test('changed picker DOM fails open to the original core picker flow', () => {
  const b = browser();
  b.apply();
  b.tools.classes.clear();
  const video = b.nativeFile('picked.mp4', 'video/mp4');
  const original = b.change([video]);
  assert.equal(original.immediate, false);
  assert.equal(b.events.length, 1);
  assert.equal(b.references[0].file, video);
});

test('unload removes all listeners and restores host-path intake; reapply adds one set', () => {
  const b = browser();
  const initialListeners = b.window.listeners.length;
  b.apply();
  assert.deepEqual(b.window.listeners.map(({ type, capture }) => [type, capture]), [
    ['drop', true], ['paste', true], ['change', true],
  ]);
  b.dispose();
  assert.equal(b.window.listeners.length, initialListeners);
  const video = b.nativeFile('original.mp4', 'video/mp4');
  const original = b.drop([video]);
  assert.equal(original.immediate, false);
  assert.equal(b.references[0].file, video);
  assert.equal(b.uploads.length, 0);
  b.apply();
  b.drop([video]);
  assert.equal(b.uploads.length, 1);
  assert.equal(b.intakes.length, 2);
  b.dispose();
  assert.equal(b.window.listeners.length, initialListeners);
});

test('multiple synchronous drops each forward once without a global busy flag', () => {
  const b = browser();
  b.apply();
  for (let i = 0; i < 3; i += 1) b.drop([b.nativeFile(`${i}.mp4`, 'video/mp4')]);
  assert.equal(b.intakes.length, 3);
  assert.equal(b.events.length, 6);
  assert.equal(b.errors.length, 0);
});

test('core busy behavior still controls forwarding and does not block ordinary files globally', () => {
  const b = browser({ busy: true });
  b.apply();
  b.drop([b.nativeFile('clip.mp4', 'video/mp4')]);
  const ordinary = b.drop([b.nativeFile('plain.txt', 'text/plain')]);
  assert.equal(ordinary.immediate, false);
  assert.equal(b.events.length, 3);
  assert.equal(b.uploads.length, 0);
  assert.deepEqual(b.notices, ['attachment.dropBlocked', 'attachment.dropBlocked']);
});

test('clone, transfer and event construction failures are explicit and preserve the original files', () => {
  for (const [name, replacement] of [
    ['File', class { static [Symbol.hasInstance](file) { return file instanceof NodeFile; }
      constructor() { throw new Error('clone unavailable'); } }],
    ['DataTransfer', class { constructor() { throw new Error('transfer unavailable'); } }],
    ['DragEvent', class { constructor() { throw new Error('event unavailable'); } }],
  ]) {
    const b = browser();
    b.apply();
    const originalConstructor = b.context[name];
    b.context[name] = replacement;
    const video = b.nativeFile('clip.mp4', 'video/mp4');
    const original = b.drop([video]);
    assert.equal(original.immediate, false, name);
    assert.equal(b.intakes.length, 1, name);
    assert.equal(b.references[0].file, video, name);
    assert.equal(b.events.length, 1, name);
    assert.equal(b.errors.length, 1, name);
    assert.match(b.errors[0][0], /original input remains available/);
    b.context[name] = originalConstructor;
    b.drop([video]);
    assert.equal(b.uploads.length, 1, `${name}: later video must still upload`);
    assert.equal(b.intakes.length, 2, name);
  }
});

test('no core consumer leaves the original drop available with an explicit error', () => {
  const b = browser({ consume: false });
  b.apply();
  const original = b.drop([b.nativeFile('clip.mp4', 'video/mp4')]);
  assert.equal(original.defaultPrevented, false);
  assert.equal(original.immediate, false);
  assert.equal(b.errors.length, 1);
  assert.match(String(b.errors[0][1]), /did not consume/);
});

test('a transfer item failure preserves every original file instead of forwarding a partial list', () => {
  const b = browser();
  b.apply();
  const NativeTransfer = b.context.DataTransfer;
  b.context.DataTransfer = class extends NativeTransfer {
    constructor() {
      super();
      const add = this.items.add;
      this.items.add = (file) => this.items.length === 1 ? null : add(file);
    }
  };
  const image = b.nativeFile('first.png', 'image/png');
  const video = b.nativeFile('middle.mp4', 'video/mp4');
  const file = b.nativeFile('last.txt', 'text/plain');
  const original = b.drop([image, video, file]);
  assert.equal(original.immediate, false);
  assert.deepEqual(b.intakes[0], [image, video, file]);
  assert.equal(b.events.length, 1);
  assert.equal(b.errors.length, 1);
});

test('ordinary composer paste and picker change retain their existing handlers', () => {
  const b = browser();
  b.apply();
  const image = b.nativeFile('image.png', 'image/png');
  const file = b.nativeFile('notes.txt', 'text/plain');
  const paste = b.paste([image, file], b.editor, 'notes');
  const change = b.change([file, image]);
  assert.equal(paste.immediate, false);
  assert.equal(change.immediate, false);
  assert.equal(b.events.length, 2);
  assert.deepEqual(b.intakes, [[image, file], [file, image]]);
  assert.deepEqual(b.texts, ['notes']);
  assert.equal(b.picker.accept, '');
});

test('dispatch failure leaves original drop available to the core', () => {
  const b = browser();
  b.apply();
  const dispatch = b.editor.dispatchEvent.bind(b.editor);
  b.editor.dispatchEvent = (event) => {
    if (!event.isTrusted) throw new Error('dispatch unavailable');
    return dispatch(event);
  };
  const video = b.nativeFile('clip.mp4', 'video/mp4');
  const original = b.drop([video]);
  assert.equal(original.immediate, false);
  assert.equal(b.references[0].file, video);
  assert.equal(b.intakes.length, 1);
  assert.equal(b.errors.length, 1);
});

test('picker forwarding failure preserves the original change intake', () => {
  const b = browser();
  b.apply();
  b.context.DataTransfer = class { constructor() { throw new Error('transfer unavailable'); } };
  const video = b.nativeFile('picked.mp4', 'video/mp4');
  const original = b.change([video]);
  assert.equal(original.cancelable, false, 'native change is not cancelable');
  assert.equal(original.immediate, false);
  assert.equal(b.references[0].file, video);
  assert.equal(b.intakes.length, 1);
  assert.equal(b.errors.length, 1);
});

test('clipboard construction failure keeps all files and text in the original paste', () => {
  const b = browser();
  b.apply();
  b.context.ClipboardEvent = class { constructor() { throw new Error('clipboard unavailable'); } };
  const video = b.nativeFile('clip.mp4', 'video/mp4');
  const image = b.nativeFile('image.png', 'image/png');
  const original = b.paste([video, image], b.editor, 'caption');
  assert.equal(original.immediate, false);
  assert.deepEqual(b.intakes[0], [video, image]);
  assert.deepEqual(b.texts, ['caption']);
  assert.equal(b.events.length, 1);
  assert.equal(b.errors.length, 1);
});

test('mixed directory drops retain ordinary File identity and directory metadata', () => {
  const b = browser();
  b.apply();
  const directory = b.nativeFile('movies.mp4', '', []);
  const video = b.nativeFile('real.mp4', 'video/mp4');
  const transfer = b.transferFor([directory, video]);
  transfer.items[0].webkitGetAsEntry = () => ({ isDirectory: true });
  const original = new b.DragEvent('drop', {
    bubbles: true, cancelable: true, isTrusted: true, dataTransfer: transfer,
  });
  b.editor.dispatchEvent(original);
  assert.equal(b.intakes.length, 1);
  assert.equal(b.intakes[0][0], directory);
  assert.equal(b.references[0].directory, true);
  assert.equal(b.references[0].file, directory);
  assert.equal(b.uploads[0].file.name, video.name);
  assert.equal(b.uploads[0].file.path, '');
});

test('a different control keeps ownership of its video drop', () => {
  const b = browser();
  b.apply();
  const panel = new b.Element('div');
  b.body.append(panel);
  let received;
  panel.addEventListener('drop', (event) => {
    received = event.dataTransfer.files[0];
    event.preventDefault();
    event.stopPropagation();
  });
  const file = b.nativeFile('owned.mp4', 'video/mp4');
  b.drop([file], panel);
  assert.equal(received, file);
  assert.equal(b.intakes.length, 0);
});

test('unsupported video containers keep the stock file flow', () => {
  const b = browser();
  b.apply();
  const file = b.nativeFile('unsupported.mov', 'video/quicktime');
  const event = b.drop([file]);
  assert.equal(event.immediate, false);
  assert.equal(b.references[0].file, file);
});
