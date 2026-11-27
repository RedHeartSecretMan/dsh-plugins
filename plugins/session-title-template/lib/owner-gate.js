/**
 * Owner admission for this plugin's host routes.
 *
 * Newer Harness builds pass a Peer as the route handler's third argument, and
 * this plugin then requires `peer.principal.kind === 'owner'`. Harness 0.2.2
 * routes only receive `(req, res)` — `webServer` calls `handler(req, res)` —
 * so that Peer is absent. Treating an absent Peer as "not owner" makes every
 * settings and status request fail with 403 on those builds.
 *
 * When no Peer is supplied, admit the request only under the trust test the
 * Harness itself applies before minting the browser owner principal: a loopback
 * socket, a loopback Host header, no cross-site fetch metadata, and an Origin
 * that matches Host when one is sent. A Peer that is present stays
 * authoritative, so a newer build's explicit principal is never widened.
 * @module session-title-template/owner-gate
 */

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', '0:0:0:0:0:0:0:1', 'localhost']);

/** Read one header value, tolerating the string[] form node may produce. */
function headerValue(headers, name) {
  const raw = headers?.[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Strip IPv6 brackets so `[::1]` compares like `::1`. */
function bareHostname(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** True for every textual form of the loopback host. */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false;
  const bare = bareHostname(hostname.toLowerCase());
  return LOOPBACK_HOSTNAMES.has(bare) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(bare);
}

/**
 * True when a socket address belongs to this machine.
 *
 * Node reports IPv4-mapped IPv6 peers as `::ffff:127.0.0.1`, so both spellings
 * of loopback are accepted.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  return isLoopbackHostname(mapped ? mapped[1] : address);
}

/**
 * Split an authority (`host[:port]`) into a lower-cased hostname and its port.
 * @returns hostname and port, or undefined when the authority cannot be parsed.
 */
export function parseAuthority(authority) {
  if (typeof authority !== 'string') return undefined;
  const trimmed = authority.trim();
  if (trimmed === '') return undefined;
  const withHost = trimmed.startsWith('[')
    ? /^\[(?<hostname>[^\]]+)\](?::(?<port>\d{1,5}))?$/u.exec(trimmed)
    : /^(?<hostname>[^:/]+)(?::(?<port>\d{1,5}))?$/u.exec(trimmed);
  if (withHost?.groups === undefined) return undefined;
  const { hostname, port } = withHost.groups;
  if (hostname === undefined || hostname === '') return undefined;
  if (port !== undefined) {
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1 || value > 65535) return undefined;
  }
  return { hostname: bareHostname(hostname.toLowerCase()), port: port === undefined ? undefined : Number(port) };
}

/** Compare two authorities the way a same-origin check does. */
function sameAuthority(left, right) {
  if (left.hostname !== right.hostname) return false;
  // An omitted port means the scheme default; compare only when both name one.
  if (left.port === undefined || right.port === undefined) return true;
  return left.port === right.port;
}

/**
 * Decide whether a request that arrives without a Peer may act as the owner.
 *
 * Mirrors the Harness trust test for loopback browser sessions: the connection
 * must come from this machine, the Host header must name loopback, cross-site
 * fetches are refused, and a present Origin must match Host.
 */
export function isTrustedLoopbackRequest(request) {
  if (request === undefined || request === null || typeof request !== 'object') return false;
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  const host = parseAuthority(headerValue(request.headers, 'host'));
  if (host === undefined || !isLoopbackHostname(host.hostname)) return false;
  if (headerValue(request.headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = headerValue(request.headers, 'origin');
  if (origin === undefined || origin === '') return true;
  const parsed = parseAuthority(origin.replace(/^https?:\/\//iu, ''));
  return parsed !== undefined && sameAuthority(parsed, host);
}

/**
 * Admit a plugin route request as the local owner.
 *
 * A supplied Peer is authoritative and never widened; without one, the request
 * must pass the loopback trust test.
 */
export function isOwnerRequest(request, peer) {
  if (peer !== undefined && peer !== null) return peer.principal?.kind === 'owner';
  return isTrustedLoopbackRequest(request);
}
