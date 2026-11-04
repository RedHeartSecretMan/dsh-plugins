/**
 * session-video-intake — Host half.
 *
 * Video stays an original durable attachment. For every request the plugin
 * inspects the route the user actually selected and applies the matching
 * projection before the request leaves the host:
 *
 *   native video  → `video_url`
 *   image only    → storyboard image parts + manifest
 *   neither       → explicit VIDEO_UNSUPPORTED failure
 *
 * Native video comes from an explicit `videoRoutes` override, or — when that is
 * unset — from a fail-soft probe of the provider's model listing. No provider is
 * registered and the selected route is never changed.
 * @module session-video-intake
 */
import { resolveConfig, resolveToolPaths } from './lib/config.js';
import { createCapabilityResolver } from './lib/capability.js';
import { createVideoMiddleware } from './lib/payload.js';
import { createVideoHookManager } from './lib/provider.js';
import { createVideoRouter } from './lib/router.js';
import { createDefaultRunner, createStoryboardBuilder } from './lib/storyboard.js';

export const name = 'session-video-intake';
export const inject = ['llm', 'attachments'];

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  if (!config.enabled) {
    ctx.logger?.info?.(
      'session-video-intake: disabled; composer intake remains, video attachments follow normal file handling',
    );
    return;
  }
  if (typeof ctx.llm.fileRequestText !== 'function') {
    throw new Error('session-video-intake: this Harness does not expose llm.fileRequestText');
  }

  const storyboard = config.storyboard.enabled
    ? createStoryboardBuilder({
      run: createDefaultRunner(),
      ...resolveToolPaths(config.storyboard),
      cells: config.storyboard.cells,
      cellEdge: config.storyboard.cellEdge,
      sceneAware: config.storyboard.sceneAware,
      timeoutMs: config.storyboard.timeoutMs,
    })
    : undefined;

  const videoRoutes = config.videoRoutes === undefined ? undefined : new Set(config.videoRoutes);
  const capability = createCapabilityResolver(ctx, { videoRoutes, catalogProbe: config.catalogProbe });
  const limits = {
    maxVideoBytes: config.maxVideoBytes,
    maxTotalVideoBytes: config.maxTotalVideoBytes,
    maxVideos: config.maxVideos,
  };
  const hooks = createVideoHookManager(ctx, { limits, capabilities: capability, storyboard, logger: ctx.logger });
  hooks.ensure();
  ctx.on('llm/adapters-updated', () => {
    capability.clear();
    hooks.ensure();
  });
  ctx.effect(() => () => hooks.dispose());

  ctx.on('llm/stream', createVideoMiddleware(ctx));

  ctx.inject(['agents'], (agentCtx) => createVideoRouter(agentCtx, { capability, maxOutputTokens: config.maxOutputTokens }));

  const native = videoRoutes === undefined
    ? config.catalogProbe.enabled ? 'catalog probe' : 'disabled'
    : [...videoRoutes].join(', ') || 'disabled';
  ctx.logger?.info?.(
    `session-video-intake: attached to ${hooks.attachedProviders().join(', ') || 'no provider yet'}; `
    + `native video: ${native}; storyboard: ${storyboard ? 'enabled' : 'disabled'}`,
  );
}
