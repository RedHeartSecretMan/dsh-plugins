/** Shared plugin error shape: one prefix and a stable code for callers/tests. */
const PREFIX = 'session-video-intake: ';

export function failure(message, code = 'VIDEO_INVALID_CONFIG', cause) {
  const error = cause === undefined
    ? new Error(`${PREFIX}${message}`)
    : new Error(`${PREFIX}${message}`, { cause });
  return Object.assign(error, { code });
}

/** Throw the plugin's cancellation error when the signal is already aborted. */
export function checkAbort(signal) {
  if (signal?.aborted) throw failure('request aborted', 'ABORTED');
}
