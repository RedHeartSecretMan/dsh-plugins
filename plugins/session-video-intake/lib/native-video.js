/** Native video projection: verified attachment bytes become a data URL. */
import { readVerifiedBytes } from './attachment.js';
import { failure } from './failure.js';
import { videoExtension } from './media-input.js';

function mediaType(name, data) {
  if (videoExtension(name) === 'mp4' && data.length >= 16 && data.toString('ascii', 4, 8) === 'ftyp') {
    const size = data.readUInt32BE(0);
    const major = data.toString('ascii', 8, 12);
    const videoBrand = /^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV|qt  )$/;
    if (size >= 16 && size <= data.length && size % 4 === 0 && videoBrand.test(major)) return 'video/mp4';
  }
  if (videoExtension(name) === 'webm' && data.length >= 8 && data.readUInt32BE(0) === 0x1a45dfa3) {
    // EBML header must explicitly declare DocType=webm; Matroska is different.
    const vint = (offset) => {
      const first = data[offset];
      if (!first) return undefined;
      let length = 1;
      while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
      if (length > 8 || offset + length > data.length) return undefined;
      let value = first & (0xff >> length);
      for (let i = 1; i < length; i++) value = value * 256 + data[offset + i];
      return { length, value };
    };
    const header = vint(4);
    if (header && Number.isSafeInteger(header.value) && header.value <= data.length - 4 - header.length) {
      const end = 4 + header.length + header.value;
      for (let offset = 4 + header.length; offset < end;) {
        const first = data[offset];
        let length = 1;
        while (length <= 4 && !(first & (0x80 >> (length - 1)))) length++;
        if (length > 4 || offset + length >= end) break;
        const id = data.subarray(offset, offset + length).toString('hex');
        const size = vint(offset + length);
        if (!size || !Number.isSafeInteger(size.value)) break;
        offset += length + size.length;
        if (offset + size.value > end) break;
        if (id === '4282' && data.toString('ascii', offset, offset + size.value) === 'webm') return 'video/webm';
        offset += size.value;
      }
    }
  }
  throw failure(`attachment ${JSON.stringify(name)} does not contain the declared MP4/WebM container`, 'VIDEO_INVALID_MEDIA');
}

/** Read one durable video attachment and return its verified data URL. */
export async function fileVideo(ref, scope, limits, signal) {
  if (!/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId ?? '') || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) {
    throw failure('invalid durable file reference', 'VIDEO_INVALID_MEDIA');
  }
  if (ref.bytes > limits.maxVideoBytes) throw failure('video exceeds maxVideoBytes', 'VIDEO_LIMIT');
  const data = await readVerifiedBytes({
    ref,
    attachments: scope.attachments(),
    signal,
    maxBytes: limits.maxVideoBytes,
  });
  return `data:${mediaType(ref.name, data)};base64,${data.toString('base64')}`;
}
