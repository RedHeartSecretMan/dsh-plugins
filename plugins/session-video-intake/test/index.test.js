import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from '../index.js';

function fixture({ fileRequestText = true } = {}) {
  const listeners = [];
  const injects = [];
  const infos = [];
  const effects = [];
  const ctx = {
    llm: {
      ...(fileRequestText ? { fileRequestText: () => '[File clip.mp4]' } : {}),
      adapters: new Map(),
      listProviders: () => [],
      async resolveModelInfo() { return { inputModalities: ['text'] }; },
    },
    on(event) { listeners.push(event); return () => {}; },
    effect(setup) { effects.push(setup); return () => {}; },
    inject(services, callback) { injects.push(services.join(',')); return callback?.(ctx) ?? (() => {}); },
    get() { return undefined; },
    logger: { info(message) { infos.push(String(message)); }, warn() {}, debug() {} },
  };
  return { ctx, listeners, injects, infos, effects };
}

test('disabled configuration installs no host-side hooks', () => {
  const { ctx, listeners, injects, infos, effects } = fixture({ fileRequestText: false });
  assert.doesNotThrow(() => apply(ctx, { enabled: false }));
  assert.deepEqual(listeners, []);
  assert.deepEqual(injects, []);
  assert.deepEqual(effects, []);
  assert.match(infos.join('\n'), /disabled/);
});

test('enabled configuration installs hooks, middleware and router', () => {
  const { ctx, listeners, injects, effects } = fixture();
  apply(ctx, {
    enabled: true,
    videoRoutes: [],
    storyboard: { enabled: false },
  });
  assert.ok(listeners.includes('llm/stream'));
  assert.ok(listeners.includes('llm/adapters-updated'));
  assert.deepEqual(injects, ['agents']);
  assert.equal(effects.length, 1);
});
