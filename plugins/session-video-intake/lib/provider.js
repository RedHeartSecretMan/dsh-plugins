/**
 * Attach the video payload hook to every registered provider.
 *
 * DSH's pi-ai adapter keeps one stable profile object per provider and
 * dispatches through `profile.piProvider.streamSimple`. Wrapping that function
 * lets this plugin decide, per request, whether the route consumes video
 * natively or needs a storyboard. No second provider is registered.
 */
import { installPayloadHook } from './payload.js';
import { providerPiProvider } from './capability.js';

export function createVideoHookManager(ctx, { limits, capabilities, storyboard, logger }) {
  const installed = new Map();

  /** Install hooks for new providers and drop hooks for removed ones. */
  const ensure = () => {
    const providers = typeof ctx.llm?.listProviders === 'function' ? ctx.llm.listProviders() : [];
    const seen = new Set();
    for (const entry of providers) {
      const provider = entry?.id;
      if (typeof provider !== 'string' || seen.has(provider)) continue;
      const object = providerPiProvider(ctx, provider);
      if (!object) continue;
      seen.add(provider);
      const current = installed.get(provider);
      if (current?.object === object) continue;
      if (current) current.restore();
      try {
        installed.set(provider, { object, restore: installPayloadHook(object, { limits, capabilities, storyboard }) });
      } catch (error) {
        logger?.warn?.(`session-video-intake: could not attach to provider ${provider}: ${error?.message ?? error}`);
      }
    }
    for (const [provider, current] of installed) {
      if (seen.has(provider)) continue;
      current.restore();
      installed.delete(provider);
    }
    return installed.size;
  };

  const dispose = () => {
    for (const current of installed.values()) current.restore();
    installed.clear();
  };

  return { ensure, dispose, attachedProviders: () => [...installed.keys()] };
}
