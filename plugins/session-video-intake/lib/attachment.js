/** Read a durable attachment once and verify its byte count and SHA-256. */
import { createHash } from 'node:crypto';
import { failure } from './failure.js';

export const NATIVE_MEDIA_CODES = Object.freeze({
  unsupported: 'VIDEO_SDK_UNSUPPORTED',
  limit: 'VIDEO_LIMIT',
  invalid: 'VIDEO_INVALID_MEDIA',
  integrity: 'VIDEO_INVALID_MEDIA',
});

export const STORYBOARD_MEDIA_CODES = Object.freeze({
  unsupported: 'VIDEO_STORYBOARD_INVALID_SOURCE',
  limit: 'VIDEO_STORYBOARD_INVALID_SOURCE',
  invalid: 'VIDEO_STORYBOARD_INVALID_SOURCE',
  integrity: 'VIDEO_STORYBOARD_INVALID_SOURCE',
});

async function readBytes({ ref, attachments, signal, maxBytes, codes = NATIVE_MEDIA_CODES, onStreamError }) {
  if (typeof attachments?.readFileStream !== 'function') {
    throw failure('durable attachments.readFileStream is required', codes.unsupported);
  }
  const chunks = [];
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of attachments.readFileStream(ref, signal)) {
      if (signal?.aborted) throw failure('request aborted', 'ABORTED');
      if (!(chunk instanceof Uint8Array)) throw failure('attachment stream returned non-byte data', codes.invalid);
      bytes += chunk.byteLength;
      if ((maxBytes !== undefined && bytes > maxBytes) || bytes > ref.bytes) {
        throw failure('video exceeds its byte bound', codes.limit);
      }
      const copy = Buffer.from(chunk);
      chunks.push(copy);
      hash.update(copy);
    }
  } catch (error) {
    if (!onStreamError || typeof error?.code === 'string') throw error;
    throw onStreamError(error);
  }
  if (signal?.aborted) throw failure('request aborted', 'ABORTED');
  if (bytes !== ref.bytes || `sha256:${hash.digest('hex')}` !== ref.attachmentId) {
    throw failure('attachment failed byte count or SHA-256 integrity verification', codes.integrity);
  }
  return Buffer.concat(chunks, bytes);
}

/** Read and verify native-video attachment bytes; stream errors propagate. */
export function readVerifiedBytes(options) {
  return readBytes(options);
}

/** Read and verify storyboard attachment bytes; non-plugin stream errors wrap. */
export function readVerifiedStoryboardBytes(options) {
  return readBytes({
    ...options,
    onStreamError: (error) => failure(
      `could not read the video attachment: ${error?.message ?? error}`,
      (options.codes ?? STORYBOARD_MEDIA_CODES).invalid,
      error?.cause ?? error,
    ),
  });
}
