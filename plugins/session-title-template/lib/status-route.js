/**
 * Authenticated HTTP routes for inspecting status and refreshing titles without
 * appending `/title` command blocks into the live conversation log.
 *
 * Executing `/title status` or `/title refresh` through the command service
 * appends durable `command/run` and `command/done` events to the active session
 * log, which renders a command card in the open conversation and makes the page
 * scroll right as the user interacts with the sidebar menu. Exposing owner-only
 * routes on the Host's authenticated `webServer` avoids mutating the transcript
 * and also lets status inspection read persisted cold sessions without resuming
 * an agent.
 *
 * @module session-title-template/status-route
 */

import { isOwnerRequest } from './owner-gate.js';
import { sendJson, safeCategory, readJsonBody } from './http.js';
import { renderTitleStatus } from './title-command.js';

/** Exact authenticated GET path registered on the Host's webServer. */
export const STATUS_ROUTE_PATH = '/session-title-template/status';

/** Exact authenticated POST path registered on the Host's webServer. */
export const REFRESH_ROUTE_PATH = '/session-title-template/refresh';

// The JSON envelope helpers live in ./http.js; re-exported here because the
// settings route used to import them from this module.
export { sendJson, safeCategory, readJsonBody };

/**
 * Register the owner-only status (GET) and optional silent refresh (POST)
 * routes when `webServer` is present.
 *
 * @param ctx - Cordis context providing `webServer`, `sessions` and `effect`.
 * @param deps - Live/cold snapshot builders, optional refresh handler and diagnostic store.
 */
export function registerStatusRoute(ctx, { describe, describeCold, refresh, state }) {
  if (typeof ctx.webServer?.register !== 'function') return;

  const disposeStatus = ctx.webServer.register({
    kind: 'exact',
    auth: 'required',
    path: STATUS_ROUTE_PATH,
    async handler(req, res, peer) {
      if (!isOwnerRequest(req, peer)) {
        sendJson(res, 403, { code: 'forbidden', message: 'owner access required' });
        return;
      }
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET');
        sendJson(res, 405, { code: 'method-not-allowed', message: 'GET required' });
        return;
      }
      let sessionId = '';
      try {
        sessionId = new URL(String(req.url ?? ''), 'http://localhost').searchParams.get('sessionId')?.trim() ?? '';
      } catch {
        sessionId = '';
      }
      if (sessionId === '') {
        sendJson(res, 400, { code: 'invalid-session-id', message: 'sessionId query parameter is required' });
        return;
      }
      const session = ctx.sessions?.get?.(sessionId);
      if (session !== undefined) {
        try {
          const snapshot = await describe(session);
          sendJson(res, 200, { snapshot, text: renderTitleStatus(snapshot), live: true });
        } catch (error) {
          const safe = safeCategory(error);
          state?.record?.({ kind: 'title-status-route-failed', sessionId, category: safe });
          sendJson(res, 500, { code: 'status-failed', category: safe, message: `Failed to read title status (${safe})` });
        }
        return;
      }
      if (typeof describeCold !== 'function') {
        sendJson(res, 404, { code: 'session-not-open', message: 'Session is not currently open' });
        return;
      }
      try {
        const cold = await describeCold(sessionId);
        if (cold?.unavailable) {
          sendJson(res, 404, { code: 'session-not-open', message: 'Session is not currently open' });
          return;
        }
        if (cold?.notFound || cold?.snapshot === undefined) {
          sendJson(res, 404, { code: 'session-not-found', message: 'Session not found' });
          return;
        }
        sendJson(res, 200, { snapshot: cold.snapshot, text: renderTitleStatus(cold.snapshot), live: false });
      } catch (error) {
        const safe = safeCategory(error);
        state?.record?.({ kind: 'title-status-route-failed', sessionId, category: safe });
        sendJson(res, 500, { code: 'status-failed', category: safe, message: `Failed to read title status (${safe})` });
      }
    },
  });
  ctx.effect?.(() => disposeStatus, 'session-title-template: status route');

  if (typeof refresh !== 'function') return;

  const disposeRefresh = ctx.webServer.register({
    kind: 'exact',
    auth: 'required',
    path: REFRESH_ROUTE_PATH,
    async handler(req, res, peer) {
      if (!isOwnerRequest(req, peer)) {
        sendJson(res, 403, { code: 'forbidden', message: 'owner access required' });
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        sendJson(res, 405, { code: 'method-not-allowed', message: 'POST required' });
        return;
      }
      const essence = String(req.headers?.['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
      if (essence !== 'application/json') {
        sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' });
        return;
      }
      let parsed;
      try {
        parsed = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { code: 'bad-request', message: 'Request body must be valid JSON' });
        return;
      }
      if (parsed.tooLarge) {
        sendJson(res, 413, { code: 'payload-too-large', message: 'Request body exceeds limit' });
        return;
      }
      const sessionId = typeof parsed.value?.sessionId === 'string' ? parsed.value.sessionId.trim() : '';
      if (sessionId === '') {
        sendJson(res, 400, { code: 'invalid-session-id', message: 'sessionId body field is required' });
        return;
      }
      const session = ctx.sessions?.get?.(sessionId);
      if (session === undefined) {
        sendJson(res, 404, { code: 'session-not-open', message: 'Session is not currently open' });
        return;
      }
      const abort = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) abort.abort(new Error('session-title-template: refresh request closed'));
      };
      res.once?.('close', onClose);
      try {
        const accepted = await refresh(session, abort.signal);
        if (accepted === undefined) {
          sendJson(res, 409, { code: 'no-eligible-message', message: 'No eligible user message exists for title generation' });
          return;
        }
        try {
          await ctx.sessions?.flush?.(session);
        } catch {
          // Title is already accepted in the session log; flush failure is surfaced on next write.
        }
        sendJson(res, 200, { title: accepted.title, source: accepted.source?.kind ?? 'provider' });
      } catch (error) {
        if (abort.signal.aborted) return;
        const safe = safeCategory(error);
        state?.record?.({ kind: 'title-refresh-route-failed', sessionId, category: safe });
        sendJson(res, 500, { code: 'refresh-failed', category: safe, message: `Failed to refresh title (${safe})` });
      } finally {
        res.off?.('close', onClose);
      }
    },
  });
  ctx.effect?.(() => disposeRefresh, 'session-title-template: refresh route');
}
