import test from 'node:test';
import assert from 'node:assert/strict';
import { registerStatusRoute, STATUS_ROUTE_PATH, REFRESH_ROUTE_PATH } from '../lib/status-route.js';

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

function createHostContext({ sessions = new Map() } = {}) {
  const routes = [];
  const disposers = [];
  const ctx = {
    sessions: { get: id => sessions.get(id) },
    webServer: {
      register(route) {
        routes.push(route);
        return () => { route.disposed = true; };
      },
    },
    effect(setup) { disposers.push(setup()); },
  };
  return { ctx, routes, disposers };
}

test('registers an authenticated exact GET status route and cleans up on dispose', () => {
  const { ctx, routes, disposers } = createHostContext();
  registerStatusRoute(ctx, { describe: async () => ({}) });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'exact');
  assert.equal(routes[0].auth, 'required');
  assert.equal(routes[0].path, STATUS_ROUTE_PATH);
  assert.equal(disposers.length, 1);
  disposers[0]();
  assert.equal(routes[0].disposed, true);
});

test('rejects non-owner peers, non-GET methods, missing sessionId and unopened sessions', async () => {
  const { ctx, routes } = createHostContext();
  registerStatusRoute(ctx, { describe: async () => ({}) });
  const { handler } = routes[0];
  const owner = { principal: { kind: 'owner' } };

  const res403 = createMockResponse();
  await handler({ method: 'GET', url: `${STATUS_ROUTE_PATH}?sessionId=S1` }, res403, { principal: { kind: 'guest' } });
  assert.equal(res403.statusCode, 403);
  assert.equal(res403.json().code, 'forbidden');

  const res405 = createMockResponse();
  await handler({ method: 'POST', url: `${STATUS_ROUTE_PATH}?sessionId=S1` }, res405, owner);
  assert.equal(res405.statusCode, 405);
  assert.equal(res405.headers.get('allow'), 'GET');

  const res400 = createMockResponse();
  await handler({ method: 'GET', url: STATUS_ROUTE_PATH }, res400, owner);
  assert.equal(res400.statusCode, 400);
  assert.equal(res400.json().code, 'invalid-session-id');

  const res404 = createMockResponse();
  await handler({ method: 'GET', url: `${STATUS_ROUTE_PATH}?sessionId=cold-1` }, res404, owner);
  assert.equal(res404.statusCode, 404);
  assert.equal(res404.json().code, 'session-not-open');
});

test('returns non-cacheable structured snapshot and text for a live session without mutating it', async () => {
  let appended = 0;
  const session = { id: 'S1', append() { appended += 1; } };
  const snapshot = {
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
    title: { value: '[1125][修复] 修复页面抖动', source: 'provider', pinned: false },
    lastFailure: null,
    probe: { verdict: 'supported', checkedAt: '2026-11-25T05:00:00Z' },
  };
  const { ctx, routes } = createHostContext({ sessions: new Map([['S1', session]]) });
  registerStatusRoute(ctx, { describe: async (target) => { assert.equal(target, session); return snapshot; } });

  const res = createMockResponse();
  await routes[0].handler(
    { method: 'GET', url: `${STATUS_ROUTE_PATH}?sessionId=S1` },
    res,
    { principal: { kind: 'owner' } },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const payload = res.json();
  assert.deepEqual(payload.snapshot, snapshot);
  assert.match(payload.text, /修复页面抖动/);
  assert.equal(appended, 0);
});

test('contains handler errors without leaking raw exception messages', async () => {
  const session = { id: 'S1' };
  const records = [];
  const { ctx, routes } = createHostContext({ sessions: new Map([['S1', session]]) });
  registerStatusRoute(ctx, {
    describe: async () => { throw Object.assign(new Error('secret-provider-body'), { code: 'EIO' }); },
    state: { record: entry => records.push(entry) },
  });

  const res = createMockResponse();
  await routes[0].handler(
    { method: 'GET', url: `${STATUS_ROUTE_PATH}?sessionId=S1` },
    res,
    { principal: { kind: 'owner' } },
  );
  assert.equal(res.statusCode, 500);
  const payload = res.json();
  assert.equal(payload.code, 'status-failed');
  assert.doesNotMatch(payload.message, /secret-provider-body/);
  assert.deepEqual(records, [{ kind: 'title-status-route-failed', sessionId: 'S1', category: 'EIO' }]);
});

test('reads persisted cold sessions via describeCold and reports missing sessions as 404', async () => {
  const coldSnapshot = {
    summary: '内置规则',
    builtin: { template: '[{date}][{type}] {topic}' },
    supplemental: { count: 0, sources: [] },
    title: { value: '[1125][文档] 冷会话状态', source: 'provider', pinned: false },
    lastFailure: null,
    probe: null,
  };
  const { ctx, routes } = createHostContext();
  registerStatusRoute(ctx, {
    describe: async () => { throw new Error('should not call live describe'); },
    describeCold: async (id) => (id === 'cold-1' ? { snapshot: coldSnapshot } : { notFound: true }),
  });
  const owner = { principal: { kind: 'owner' } };

  const resOk = createMockResponse();
  await routes[0].handler({ method: 'GET', url: `${STATUS_ROUTE_PATH}?sessionId=cold-1` }, resOk, owner);
  assert.equal(resOk.statusCode, 200);
  assert.equal(resOk.json().live, false);
  assert.deepEqual(resOk.json().snapshot, coldSnapshot);

  const resMissing = createMockResponse();
  await routes[0].handler({ method: 'GET', url: `${STATUS_ROUTE_PATH}?sessionId=missing` }, resMissing, owner);
  assert.equal(resMissing.statusCode, 404);
  assert.equal(resMissing.json().code, 'session-not-found');
});

test('registers an authenticated POST refresh route that refreshes live sessions without mutating command history', async () => {
  const session = { id: 'S1' };
  let flushed = 0;
  const records = [];
  const { ctx, routes, disposers } = createHostContext({ sessions: new Map([['S1', session]]) });
  ctx.sessions.flush = async () => { flushed += 1; return true; };

  let mode = 'ok';
  registerStatusRoute(ctx, {
    describe: async () => ({}),
    refresh: async (target) => {
      assert.equal(target, session);
      if (mode === 'empty') return undefined;
      if (mode === 'error') throw Object.assign(new Error('secret-token-body'), { code: 'ETIMEDOUT' });
      return { title: '[1125][优化] 刷新后的标题', source: { kind: 'provider' } };
    },
    state: { record: entry => records.push(entry) },
  });

  const refreshRoute = routes.find(route => route.path === REFRESH_ROUTE_PATH);
  assert.ok(refreshRoute);
  assert.equal(refreshRoute.kind, 'exact');
  assert.equal(refreshRoute.auth, 'required');
  assert.equal(disposers.length, 2);

  const owner = { principal: { kind: 'owner' } };
  const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

  const res403 = createMockResponse();
  await refreshRoute.handler({ method: 'POST', headers: jsonHeaders, body: { sessionId: 'S1' } }, res403, { principal: { kind: 'guest' } });
  assert.equal(res403.statusCode, 403);

  const res405 = createMockResponse();
  await refreshRoute.handler({ method: 'GET', headers: jsonHeaders }, res405, owner);
  assert.equal(res405.statusCode, 405);
  assert.equal(res405.headers.get('allow'), 'POST');

  const res415 = createMockResponse();
  await refreshRoute.handler({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }, res415, owner);
  assert.equal(res415.statusCode, 415);

  const res400 = createMockResponse();
  await refreshRoute.handler({ method: 'POST', headers: jsonHeaders, body: '{' }, res400, owner);
  assert.equal(res400.statusCode, 400);

  const res404 = createMockResponse();
  await refreshRoute.handler({ method: 'POST', headers: jsonHeaders, body: { sessionId: 'cold-1' } }, res404, owner);
  assert.equal(res404.statusCode, 404);
  assert.equal(res404.json().code, 'session-not-open');

  const res200 = createMockResponse();
  await refreshRoute.handler({ method: 'POST', headers: jsonHeaders, body: { sessionId: 'S1' } }, res200, owner);
  assert.equal(res200.statusCode, 200);
  assert.equal(res200.headers.get('cache-control'), 'no-store');
  assert.deepEqual(res200.json(), { title: '[1125][优化] 刷新后的标题', source: 'provider' });
  assert.equal(flushed, 1);

  mode = 'empty';
  const res409 = createMockResponse();
  await refreshRoute.handler({ method: 'POST', headers: jsonHeaders, body: { sessionId: 'S1' } }, res409, owner);
  assert.equal(res409.statusCode, 409);
  assert.equal(res409.json().code, 'no-eligible-message');

  mode = 'error';
  const res500 = createMockResponse();
  await refreshRoute.handler({ method: 'POST', headers: jsonHeaders, body: { sessionId: 'S1' } }, res500, owner);
  assert.equal(res500.statusCode, 500);
  assert.equal(res500.json().code, 'refresh-failed');
  assert.equal(res500.json().category, 'ETIMEDOUT');
  assert.doesNotMatch(res500.json().message, /secret-token-body/);
  assert.deepEqual(records, [{ kind: 'title-refresh-route-failed', sessionId: 'S1', category: 'ETIMEDOUT' }]);

  for (const dispose of disposers) dispose();
  assert.equal(refreshRoute.disposed, true);
});
