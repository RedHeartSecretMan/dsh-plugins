import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, resolveConfig, resolveToolPaths } from '../lib/config.js';

const configError = /session-video-intake: config\./;

test('defaults materialize as frozen settings', () => {
  const config = resolveConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.videoRoutes, undefined, 'unset videoRoutes means catalog discovery');
  assert.deepEqual({ ...config.catalogProbe }, { enabled: true, timeoutMs: 2500, ttlMs: 300000 });
  assert.equal(config.maxOutputTokens, 32768);
  assert.equal(config.maxVideoBytes, 64 * 1024 * 1024);
  assert.equal(config.maxTotalVideoBytes, 64 * 1024 * 1024);
  assert.equal(config.maxVideos, 8);
  assert.deepEqual({ ...config.storyboard }, {
    enabled: true, sceneAware: true, cells: 9, cellEdge: 256, timeoutMs: 120000, ffmpegPath: undefined, ffprobePath: undefined,
  });
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.catalogProbe));
  assert.ok(Object.isFrozen(config.storyboard));
});

test('omitted videoRoutes differ from an explicit empty list', () => {
  assert.equal(resolveConfig().videoRoutes, undefined);
  assert.equal(resolveConfig({ videoRoutes: undefined }).videoRoutes, undefined);
  const disabled = resolveConfig({ videoRoutes: [] });
  assert.deepEqual(disabled.videoRoutes, []);
  assert.ok(Object.isFrozen(disabled.videoRoutes), 'explicit lists are frozen');
  const explicit = resolveConfig({ videoRoutes: ['magpie/auto/deepseek-flash'] });
  assert.deepEqual(explicit.videoRoutes, ['magpie/auto/deepseek-flash']);
  assert.equal(resolveConfig({ catalogProbe: { enabled: false } }).videoRoutes, undefined);
});

test('resolved settings do not follow later mutation of the raw patch', () => {
  const raw = { videoRoutes: ['magpie/model-a'], storyboard: { cells: 4 }, catalogProbe: { ttlMs: 60000 } };
  const config = resolveConfig(raw);
  raw.videoRoutes.push('magpie/model-b');
  raw.storyboard.cells = 16;
  raw.catalogProbe.ttlMs = 120000;
  assert.deepEqual(config.videoRoutes, ['magpie/model-a']);
  assert.equal(config.storyboard.cells, 4);
  assert.equal(config.catalogProbe.ttlMs, 60000);
  assert.equal(DEFAULTS.storyboard.cells, 9, 'defaults must not be mutated');
});

test('unknown keys and invalid types are activation errors', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /config\.nope is an unknown key/);
  assert.throws(() => resolveConfig({ storyboard: { nope: true } }), /config\.storyboard\.nope is an unknown key/);
  assert.throws(() => resolveConfig({ catalogProbe: { nope: true } }), /config\.catalogProbe\.nope is an unknown key/);
  assert.throws(() => resolveConfig({ enabled: 'yes' }), /config\.enabled must be a boolean/);
  assert.throws(() => resolveConfig({ catalogProbe: { enabled: 1 } }), /config\.catalogProbe\.enabled must be a boolean/);
  assert.throws(() => resolveConfig({ storyboard: { cells: '9' } }), /config\.storyboard\.cells must be an integer/);
  assert.throws(() => resolveConfig({ storyboard: { sceneAware: 'yes' } }), /config\.storyboard\.sceneAware must be a boolean/);
  for (const raw of ['text', 4, [], true]) {
    assert.throws(() => resolveConfig(raw), configError);
  }
  assert.deepEqual(resolveConfig(null), resolveConfig(), 'null means defaults, like an absent config block');
});

test('native video routes require exact provider/model pairs', () => {
  for (const entry of [null, 4, {}, 'magpie', 'magpie/', '/model', 'a//b', 'a/b/']) {
    assert.throws(() => resolveConfig({ videoRoutes: [entry] }), /config\.videoRoutes\[0\]/, String(entry));
  }
  assert.throws(() => resolveConfig({ videoRoutes: 'magpie/model' }), /videoRoutes must be an array/);
  assert.throws(() => resolveConfig({ videoRoutes: ['a/b', 'a/b'] }), /duplicates an earlier route/);
  // Model ids may contain slashes; the provider is everything before the first one.
  assert.deepEqual(resolveConfig({ videoRoutes: ['magpie/auto/deepseek-flash'] }).videoRoutes, ['magpie/auto/deepseek-flash']);
});

test('numeric settings enforce their ranges', () => {
  const cases = [
    ['maxOutputTokens', 0], ['maxOutputTokens', 1048577], ['maxOutputTokens', 1.5],
    ['maxVideoBytes', 0], ['maxTotalVideoBytes', 2147483648], ['maxVideos', 0], ['maxVideos', 65],
  ];
  for (const [field, value] of cases) {
    assert.throws(() => resolveConfig({ [field]: value }), new RegExp(`config\\.${field}`), `${field}=${value}`);
  }
  for (const [field, value] of [['cells', 3], ['cells', 17], ['cellEdge', 63], ['cellEdge', 1025], ['timeoutMs', 999], ['timeoutMs', 600001]]) {
    assert.throws(() => resolveConfig({ storyboard: { [field]: value } }), new RegExp(`config\\.storyboard\\.${field}`));
  }
  for (const [field, value] of [['timeoutMs', 199], ['timeoutMs', 10001], ['ttlMs', 9999], ['ttlMs', 3600001]]) {
    assert.throws(() => resolveConfig({ catalogProbe: { [field]: value } }), new RegExp(`config\\.catalogProbe\\.${field}`));
  }
  assert.equal(resolveConfig({ maxVideos: 1 }).maxVideos, 1);
  assert.equal(resolveConfig({ storyboard: { cells: 4 } }).storyboard.cells, 4);
  assert.equal(resolveConfig({ catalogProbe: { timeoutMs: 10000, ttlMs: 10000 } }).catalogProbe.timeoutMs, 10000);
});

test('tool paths come from config, environment, then the Homebrew default', (t) => {
  const previous = process.env.SESSION_VIDEO_FFMPEG;
  t.after(() => {
    if (previous === undefined) delete process.env.SESSION_VIDEO_FFMPEG;
    else process.env.SESSION_VIDEO_FFMPEG = previous;
  });

  assert.throws(() => resolveConfig({ storyboard: { ffmpegPath: '' } }), /must be a non-empty path string/);
  const explicit = resolveToolPaths(resolveConfig({ storyboard: { ffmpegPath: '/tmp/custom-ffmpeg' } }).storyboard);
  assert.equal(explicit.ffmpegPath, '/tmp/custom-ffmpeg');

  process.env.SESSION_VIDEO_FFMPEG = '/tmp/env-ffmpeg';
  assert.equal(resolveToolPaths(resolveConfig().storyboard).ffmpegPath, '/tmp/env-ffmpeg', 'environment overrides the default');

  const both = resolveToolPaths(resolveConfig({ storyboard: { ffmpegPath: '/tmp/config-ffmpeg' } }).storyboard);
  assert.equal(both.ffmpegPath, '/tmp/config-ffmpeg', 'config wins over the environment');
  assert.match(both.ffprobePath, /ffprobe$/, 'missing tools fall back to a command name');
});
