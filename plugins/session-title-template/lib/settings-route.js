/**
 * Owner-only HTTP route behind the sidebar's "Naming settings" dialog and the
 * plugin detail page's developer YAML editor.
 *
 * `GET` reports the active form values, discovered LLM model catalog, and
 * canonical YAML snapshots; `POST` applies either a form change set, a full
 * YAML replacement (`mode: 'yaml'`), or a reset to bundle defaults
 * (`mode: 'reset'`), always persisting through the Harness `configEditor`.
 *
 * @module session-title-template/settings-route
 */

import { isDeepStrictEqual } from 'node:util';
import { resolveConfig } from './config.js';
import { isOwnerRequest } from './owner-gate.js';
import {
  applySettings,
  applyYamlConfig,
  formatFullConfigYaml,
  formatRawConfigYaml,
  settingsOptions,
  settingsValues,
} from './settings.js';
import { readJsonBody, safeCategory, sendJson } from './http.js';

/** Exact authenticated path serving both the GET and POST verbs. */
export const SETTINGS_ROUTE_PATH = '/session-title-template/settings';

/** Larger JSON body cap for full YAML documents and custom type vocabularies. */
const SETTINGS_MAX_BODY_BYTES = 64 * 1024;

/** Bounded deadline per provider catalog query so a slow adapter never stalls GET. */
const CATALOG_TIMEOUT_MS = 3000;

/**
 * Discover available providers and their models from `ctx.llm` without failing
 * or stalling when an adapter is slow or offline.
 *
 * @param llm - Optional Host `llm` service.
 * @returns Provider-grouped model catalog for the model selectors.
 */
export async function loadModelCatalog(llm) {
  if (typeof llm?.listProviders !== 'function') return [];
  let providers;
  try {
    providers = await Promise.resolve(llm.listProviders());
  } catch {
    return [];
  }
  if (!Array.isArray(providers) || providers.length === 0) return [];
  const groups = await Promise.all(providers.map(async (provider) => {
    if (typeof provider?.id !== 'string' || provider.id.length === 0) return null;
    const providerName = typeof provider.name === 'string' && provider.name.length > 0
      ? provider.name
      : provider.id;
    let models = [];
    if (typeof llm.listModels === 'function') {
      let timer;
      try {
        const fetched = await Promise.race([
          Promise.resolve(llm.listModels(provider.id)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('catalog timeout')), CATALOG_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
        if (Array.isArray(fetched)) {
          models = fetched
            .filter(entry => typeof entry?.id === 'string' && entry.id.length > 0)
            .map(entry => ({
              id: entry.id,
              name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id,
            }));
        }
      } catch {
        // An unavailable provider catalog simply omits that provider from suggestions.
      } finally {
        clearTimeout(timer);
      }
    }
    return models.length > 0 ? { id: provider.id, name: providerName, models } : null;
  }));
  return groups.filter(Boolean);
}

/** Build the canonical snapshot fields shared across GET and POST responses. */
function snapshotPayload(raw, resolved) {
  return {
    values: settingsValues(resolved),
    yaml: formatRawConfigYaml(raw),
    fullYaml: formatFullConfigYaml(resolved),
  };
}

/**
 * Report one failed editor write in the shape every save mode shares.
 *
 * A higher patch layer wins over this row, which the editor reports as
 * "overridden by …"; that is a 409 with its own code so the form explains the
 * layer instead of showing a generic failure. Everything else is a 500 whose
 * message names the mode that failed and never carries the raw exception text.
 *
 * @param res - Response to answer.
 * @param error - Error thrown by `editor.edit`.
 * @param state - Diagnostic state store, when the route has one.
 * @param message - Builds the 500 message from the safe category.
 */
function respondSaveFailure(res, error, state, message) {
  const overridden = /overridden by/u.test(String(error?.message ?? ''));
  const safe = safeCategory(error);
  state?.record?.({ kind: 'settings-save-failed', category: overridden ? 'config-overridden' : safe });
  if (overridden) {
    sendJson(res, 409, {
      code: 'config-overridden',
      message: 'A home patch or command-line overlay overrides this plugin configuration',
    });
    return;
  }
  sendJson(res, 500, { code: 'save-failed', category: safe, message: message(safe) });
}

/**
 * Register the settings route when `webServer` is present.
 *
 * @param ctx - Cordis context providing `webServer` and `effect`.
 * @param deps - Active resolved `config`, its `rawConfig`, optional `llm`
 * service for model discovery, a `getEditor` lookup returning `{ editor, entry }`
 * (either may be absent), and the diagnostic `state`.
 */
export function registerSettingsRoute(ctx, { config, rawConfig, llm, getEditor, state }) {
  if (typeof ctx.webServer?.register !== 'function') return;
  let saving = false;
  const activeRaw = rawConfig ?? {};

  const dispose = ctx.webServer.register({
    kind: 'exact',
    auth: 'required',
    path: SETTINGS_ROUTE_PATH,
    async handler(req, res, peer) {
      if (!isOwnerRequest(req, peer)) {
        sendJson(res, 403, { code: 'forbidden', message: 'owner access required' });
        return;
      }
      const { editor, entry } = getEditor();
      const editable = editor !== undefined && entry !== undefined;

      if (req.method === 'GET') {
        const models = await loadModelCatalog(llm ?? ctx.get?.('llm'));
        sendJson(res, 200, {
          editable,
          ...(editable ? {} : { reason: 'editor-unavailable' }),
          ...snapshotPayload(activeRaw, config),
          options: settingsOptions(config, models),
        });
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'GET, POST');
        sendJson(res, 405, { code: 'method-not-allowed', message: 'GET or POST required' });
        return;
      }
      const essence = String(req.headers?.['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
      if (essence !== 'application/json') {
        sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' });
        return;
      }
      if (!editable) {
        sendJson(res, 409, { code: 'editor-unavailable', message: 'This profile cannot save plugin configuration' });
        return;
      }
      let parsed;
      try {
        parsed = await readJsonBody(req, SETTINGS_MAX_BODY_BYTES);
      } catch {
        sendJson(res, 400, { code: 'bad-request', message: 'Request body must be valid JSON' });
        return;
      }
      if (parsed.tooLarge) {
        sendJson(res, 413, { code: 'payload-too-large', message: 'Request body exceeds limit' });
        return;
      }

      const body = parsed.value;
      const mode = body?.mode === 'yaml' ? 'yaml' : body?.mode === 'reset' ? 'reset' : 'form';

      if (mode === 'reset') {
        if (saving) {
          sendJson(res, 409, { code: 'save-in-progress', message: 'Another settings save is still running' });
          return;
        }
        // When the editor exposes current layers, avoid an unnecessary reload if already at defaults.
        if (typeof editor.configuration === 'function') {
          try {
            const layer = editor.configuration().find(item => item.entry === entry);
            if (layer !== undefined && isDeepStrictEqual(activeRaw, layer.inherited ?? {})) {
              const resolved = resolveConfig(layer.inherited ?? {});
              sendJson(res, 200, { saved: true, restarted: false, ...snapshotPayload(layer.inherited ?? {}, resolved) });
              return;
            }
          } catch { /* fall through to editor.edit */ }
        }
        saving = true;
        try {
          let nextRaw = {};
          await editor.edit(entry, (_current, inherited) => {
            nextRaw = structuredClone(inherited ?? {});
            return nextRaw;
          });
          const resolved = resolveConfig(nextRaw);
          sendJson(res, 200, { saved: true, restarted: true, ...snapshotPayload(nextRaw, resolved) });
        } catch (error) {
          respondSaveFailure(res, error, state, safe => `Failed to reset settings (${safe})`);
        } finally {
          saving = false;
        }
        return;
      }

      if (mode === 'yaml') {
        let nextRaw;
        try {
          nextRaw = applyYamlConfig(body?.yaml);
        } catch (error) {
          const code = error?.code === 'invalid-yaml' ? 'invalid-yaml' : 'invalid-settings';
          sendJson(res, 400, { code, message: String(error?.message ?? 'Invalid YAML configuration') });
          return;
        }
        const nextResolved = resolveConfig(nextRaw);
        if (isDeepStrictEqual(nextRaw, activeRaw)) {
          sendJson(res, 200, { saved: true, restarted: false, ...snapshotPayload(nextRaw, nextResolved) });
          return;
        }
        if (saving) {
          sendJson(res, 409, { code: 'save-in-progress', message: 'Another settings save is still running' });
          return;
        }
        saving = true;
        try {
          await editor.edit(entry, () => structuredClone(nextRaw));
          sendJson(res, 200, { saved: true, restarted: true, ...snapshotPayload(nextRaw, nextResolved) });
        } catch (error) {
          respondSaveFailure(res, error, state, safe => `Failed to save settings (${safe})`);
        } finally {
          saving = false;
        }
        return;
      }

      // Form patch mode: validate against active raw config first, then fresh editor state.
      let preview;
      try {
        preview = applySettings(activeRaw, body?.changes);
      } catch (error) {
        sendJson(res, 400, { code: 'invalid-settings', message: String(error?.message ?? 'Invalid settings') });
        return;
      }
      const nextResolved = resolveConfig(preview);
      const nextValues = settingsValues(nextResolved);
      if (isDeepStrictEqual(nextValues, settingsValues(config))) {
        sendJson(res, 200, { saved: true, restarted: false, ...snapshotPayload(preview, nextResolved) });
        return;
      }
      if (saving) {
        sendJson(res, 409, { code: 'save-in-progress', message: 'Another settings save is still running' });
        return;
      }
      saving = true;
      try {
        let written = preview;
        await editor.edit(entry, (current) => {
          written = applySettings(current, body.changes);
          return written;
        });
        const writtenResolved = resolveConfig(written);
        sendJson(res, 200, { saved: true, restarted: true, ...snapshotPayload(written, writtenResolved) });
      } catch (error) {
        if (error?.code === 'invalid-settings') {
          sendJson(res, 400, { code: 'invalid-settings', message: String(error?.message ?? 'Invalid settings') });
          return;
        }
        respondSaveFailure(res, error, state, safe => `Failed to save settings (${safe})`);
      } finally {
        saving = false;
      }
    },
  });
  ctx.effect?.(() => dispose, 'session-title-template: settings route');
}
