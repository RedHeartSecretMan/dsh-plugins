// Best-effort install hook: keep the plugin installable offline and only
// download a managed FFmpeg when no capable local build is found.
import { resolveFfmpeg } from '../lib/ffmpeg.js';
import { ensureManagedFfmpeg } from '../lib/managed-ffmpeg.js';

try {
  const result = await resolveFfmpeg({
    storyboard: {},
    managed: () => ensureManagedFfmpeg({ env: process.env }),
  });
  const managed = result.ffmpegPath.includes('/managed/') || result.ffmpegPath.includes('\\managed\\');
  console.log(`[session-video-intake] FFmpeg ${result.version} ready${managed ? ' (managed fallback)' : ''}`);
} catch (error) {
  console.warn(`[session-video-intake] FFmpeg not ready yet: ${error?.message ?? error}`);
  console.warn('[session-video-intake] The plugin remains installed; the first storyboard will retry the capability check.');
}
