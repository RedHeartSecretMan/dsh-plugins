/** Native video projection: verified attachment bytes become a data URL. */
import { readVerifiedBytes } from './attachment.js';
import { failure } from './failure.js';
import { videoExtension } from './media-input.js';

function ftypMime(data, extension) {
  if (data.length < 16 || data.toString('ascii', 4, 8) !== 'ftyp') return undefined;
  const size = data.readUInt32BE(0);
  const major = data.toString('ascii', 8, 12);
  const videoBrand = /^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V |MSNV|qt  |3gp[4-9]|3g2[4-9])$/;
  if (size < 16 || size > data.length || size % 4 !== 0 || !videoBrand.test(major)) return undefined;
  if (extension === 'mov') return 'video/quicktime';
  if (extension === '3gp' || major.startsWith('3gp') || major.startsWith('3g2')) return 'video/3gpp';
  return 'video/mp4';
}

function ebmlDocType(data) {
  if (data.length < 8 || data.readUInt32BE(0) !== 0x1a45dfa3) return undefined;
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
  if (!header || !Number.isSafeInteger(header.value) || header.value > data.length - 4 - header.length) return undefined;
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
    if (id === '4282') return data.toString('ascii', offset, offset + size.value);
    offset += size.value;
  }
  return undefined;
}

function mediaType(name, data) {
  const extension = videoExtension(name);
  if (extension === 'mp4' || extension === 'm4v' || extension === 'mov' || extension === '3gp') {
    const mime = ftypMime(data, extension);
    if (mime) return mime;
  }
  if (extension === 'webm' || extension === 'mkv') {
    const docType = ebmlDocType(data);
    if (extension === 'webm' && docType === 'webm') return 'video/webm';
    if (extension === 'mkv' && (docType === 'matroska' || docType === 'webm')) {
      return docType === 'webm' ? 'video/webm' : 'video/x-matroska';
    }
  }
  if (extension === 'avi' && data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF'
      && data.toString('ascii', 8, 12) === 'AVI ') return 'video/x-msvideo';
  if ((extension === 'ts' || extension === 'mts' || extension === 'm2ts') && data.length >= 189 && data[0] === 0x47) {
    return 'video/mp2t';
  }
  if (extension === 'flv' && data.length >= 3 && data.toString('ascii', 0, 3) === 'FLV') return 'video/x-flv';
  if (extension === 'ogv' && data.length >= 4 && data.toString('ascii', 0, 4) === 'OggS') return 'video/ogg';
  throw failure(
    `attachment ${JSON.stringify(name)} does not contain a supported ${extension ? extension.toUpperCase() : 'video'} container`,
    'VIDEO_INVALID_MEDIA',
  );
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
