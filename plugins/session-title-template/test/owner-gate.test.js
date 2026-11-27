import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLoopbackAddress,
  isLoopbackHostname,
  isOwnerRequest,
  isTrustedLoopbackRequest,
  parseAuthority,
} from '../lib/owner-gate.js';

const ownerPeer = { principal: { kind: 'owner' } };
const guestPeer = { principal: { kind: 'guest' } };

function request({ remoteAddress = '127.0.0.1', headers = { host: '127.0.0.1:56217' } } = {}) {
  return { method: 'GET', url: '/x', socket: { remoteAddress }, headers };
}

test('a supplied peer stays authoritative', () => {
  assert.equal(isOwnerRequest(request(), ownerPeer), true);
  assert.equal(isOwnerRequest(request(), guestPeer), false);
  // 显式 owner 判定不受请求形态影响：即使不是环回也放行。
  assert.equal(isOwnerRequest(request({ remoteAddress: '10.1.2.3' }), ownerPeer), true);
});

test('an absent peer falls back to the loopback trust test', () => {
  // Harness 0.2.2 调用 handler(req, res)，第三个参数缺席。
  assert.equal(isOwnerRequest(request(), undefined), true);
  assert.equal(isOwnerRequest(request(), null), true);
});

test('rejects non-loopback connections and hosts', () => {
  assert.equal(isTrustedLoopbackRequest(request({ remoteAddress: '10.1.2.3' })), false);
  assert.equal(isTrustedLoopbackRequest(request({ headers: { host: '192.168.1.9:56217' } })), false);
  assert.equal(isTrustedLoopbackRequest(request({ headers: {} })), false);
  assert.equal(isTrustedLoopbackRequest(undefined), false);
});

test('accepts every textual loopback form', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ['10.0.0.1', '::ffff:10.0.0.1', '', 'example.com']) {
    assert.equal(isLoopbackAddress(address), false, address);
  }
  for (const host of ['localhost', 'LOCALHOST', '[::1]', '127.0.0.1']) {
    assert.equal(isLoopbackHostname(host), true, host);
  }
  for (const host of ['example.com', '192.168.0.2', '']) {
    assert.equal(isLoopbackHostname(host), false, host);
  }
});

test('a present Origin must match Host, and cross-site metadata is refused', () => {
  const sameOrigin = request({ headers: { host: '127.0.0.1:56217', origin: 'http://127.0.0.1:56217' } });
  assert.equal(isTrustedLoopbackRequest(sameOrigin), true);

  const foreignOrigin = request({ headers: { host: '127.0.0.1:56217', origin: 'https://evil.example' } });
  assert.equal(isTrustedLoopbackRequest(foreignOrigin), false);

  // 同主机不同端口也是跨源。
  const otherPort = request({ headers: { host: '127.0.0.1:56217', origin: 'http://127.0.0.1:9999' } });
  assert.equal(isTrustedLoopbackRequest(otherPort), false);

  const crossSite = request({ headers: { host: '127.0.0.1:56217', 'sec-fetch-site': 'cross-site' } });
  assert.equal(isTrustedLoopbackRequest(crossSite), false);

  const sameSite = request({ headers: { host: '127.0.0.1:56217', 'sec-fetch-site': 'same-origin' } });
  assert.equal(isTrustedLoopbackRequest(sameSite), true);
});

test('parseAuthority handles IPv4, IPv6 brackets and optional ports', () => {
  assert.deepEqual(parseAuthority('127.0.0.1:56217'), { hostname: '127.0.0.1', port: 56217 });
  assert.deepEqual(parseAuthority('localhost'), { hostname: 'localhost', port: undefined });
  assert.deepEqual(parseAuthority('[::1]:8080'), { hostname: '::1', port: 8080 });
  assert.deepEqual(parseAuthority('[::1]'), { hostname: '::1', port: undefined });
  assert.equal(parseAuthority(''), undefined);
  assert.equal(parseAuthority('host:99999'), undefined);
  assert.equal(parseAuthority(undefined), undefined);
});
