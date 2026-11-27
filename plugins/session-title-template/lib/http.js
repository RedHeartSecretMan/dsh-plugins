/**
 * HTTP primitives shared by this plugin's owner-only routes.
 *
 * A route file owns paths and handlers; the JSON response shape, the bounded
 * body reader, and the error-category sanitizer live here so two routes cannot
 * drift into different envelopes or different leak protections.
 *
 * @module session-title-template/http
 */

/** Default body size limit for JSON payloads (bytes). */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024;

/** Send one non-cacheable JSON response when the socket is still writable. */
export function sendJson(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Sanitize an error category so provider messages never leave the Host. */
export function safeCategory(error) {
  const category = error?.code ?? error?.name ?? 'Error';
  return typeof category === 'string' && /^[A-Za-z0-9_.-]+$/u.test(category) ? category : 'Error';
}

/**
 * Read and parse a bounded JSON request body.
 *
 * @param req - Incoming request; a pre-parsed `body` is used when the carrier supplied one.
 * @param maxBytes - Byte budget for the raw body.
 * @returns `{ value }` or `{ tooLarge: true }`; a malformed body rejects.
 */
export async function readJsonBody(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body, 'utf8') > maxBytes) return { tooLarge: true };
    return { value: JSON.parse(req.body) };
  }
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
    return { value: req.body };
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    bytes += buf.length;
    if (bytes > maxBytes) return { tooLarge: true };
    chunks.push(buf);
  }
  return { value: JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) };
}
