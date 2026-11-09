import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VIDEO_EXTENSIONS,
  attachmentVideoExtension,
  findBareVideoUrls,
  findVideoFileReferences,
  isVideoAttachment,
  isVideoMediaType,
  videoExtension,
  videoMediaType,
} from '../lib/media-input.js';

test('every documented video extension is recognized case-insensitively', () => {
  assert.deepEqual([...VIDEO_EXTENSIONS], [
    'mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi', 'ts', 'mts', 'm2ts', 'flv', '3gp', 'ogv',
  ]);
  for (const extension of VIDEO_EXTENSIONS) {
    assert.equal(videoExtension(`clip.${extension}`), extension);
    assert.equal(videoExtension(`clip.${extension.toUpperCase()}`), extension);
    assert.equal(videoExtension(`/media/dir/my clip.${extension}`), extension);
    assert.equal(videoExtension(`C:\\media\\my clip.${extension}`), extension);
  }
  for (const name of ['clip.mp3', 'clip.png', 'clip', 'clip.mp4.txt', '', undefined, 42]) {
    assert.equal(videoExtension(name), undefined);
  }
});

test('attachment media types recognize video/* and fall back to the name extension', () => {
  assert.equal(videoMediaType('video/mp4'), 'mp4');
  assert.equal(videoMediaType(' VIDEO/X-Matroska '), 'x-matroska');
  assert.equal(videoMediaType('image/png'), undefined);
  assert.equal(videoMediaType(undefined), undefined);
  assert.equal(isVideoMediaType('video/webm'), true);
  assert.equal(isVideoMediaType('text/plain'), false);

  assert.equal(attachmentVideoExtension({ name: 'clip.mov', bytes: 1 }), 'mov');
  // A declared video MIME type wins over a missing or unrelated name.
  assert.equal(attachmentVideoExtension({ name: 'clip', mediaType: 'video/mp4', bytes: 1 }), 'mp4');
  assert.equal(attachmentVideoExtension({ name: 'clip.txt', mediaType: 'video/webm', bytes: 1 }), 'webm');
  assert.equal(attachmentVideoExtension({ name: 'clip.mp4' }), 'mp4');
  assert.equal(attachmentVideoExtension({ name: 'notes.txt' }), undefined);
  assert.equal(isVideoAttachment({ name: 'clip.m2ts', bytes: 1 }), true);
  assert.equal(isVideoAttachment({ name: 'notes.txt', mediaType: 'image/png' }), false);
});

test('bare HTTP(S) video URLs keep their existing rules', () => {
  assert.deepEqual(findBareVideoUrls('watch https://cdn.test/a.mp4 now'), [
    { needle: 'https://cdn.test/a.mp4', url: 'https://cdn.test/a.mp4', offset: 6 },
  ]);
  assert.equal(findBareVideoUrls('[a](https://cdn.test/a.mp4)').length, 0);
  assert.equal(findBareVideoUrls('`https://cdn.test/a.webm`').length, 0);
  assert.equal(findBareVideoUrls('https://cdn.test/a.png').length, 0);
});

test('an @absolute POSIX path is an explicit local video reference', () => {
  const text = 'look at @/Users/me/videos/clip.mp4 and copy it';
  const [reference] = findVideoFileReferences(text);
  assert.deepEqual(reference, {
    needle: '@/Users/me/videos/clip.mp4',
    offset: text.indexOf('@'),
    path: '/Users/me/videos/clip.mp4',
  });
  assert.equal(text.slice(reference.offset, reference.offset + reference.needle.length), reference.needle);
});

test('Windows drive and UNC @paths are recognized without rewriting them', () => {
  const drive = 'open @C:\\Users\\me\\clips\\clip.MOV now';
  assert.deepEqual(findVideoFileReferences(drive), [{
    needle: '@C:\\Users\\me\\clips\\clip.MOV',
    offset: drive.indexOf('@'),
    path: 'C:\\Users\\me\\clips\\clip.MOV',
  }]);
  const slashDrive = 'open @D:/media/clip.m2ts';
  assert.equal(findVideoFileReferences(slashDrive)[0].path, 'D:/media/clip.m2ts');
  const unc = 'open @\\\\fileserver\\media\\clip.mkv';
  assert.equal(findVideoFileReferences(unc)[0].path, '\\\\fileserver\\media\\clip.mkv');
});

test('the composer quoted @mention form with whitespace is recognized', () => {
  const text = 'watch @"C:\\My Videos\\clip.mp4" tonight';
  const [reference] = findVideoFileReferences(text);
  assert.equal(reference.needle, '@"C:\\My Videos\\clip.mp4"');
  assert.equal(reference.path, 'C:\\My Videos\\clip.mp4');
  assert.equal(reference.offset, text.indexOf('@'));
});

test('file:// URIs pointing at a supported video are recognized', () => {
  const posix = 'watch file:///Users/me/clips/clip.webm now';
  assert.deepEqual(findVideoFileReferences(posix), [{
    needle: 'file:///Users/me/clips/clip.webm',
    offset: posix.indexOf('file:'),
    path: '/Users/me/clips/clip.webm',
  }]);
  const encoded = findVideoFileReferences('open file:///Users/me/my%20clip.ogv');
  assert.equal(encoded[0].path, '/Users/me/my clip.ogv');
  const windows = findVideoFileReferences('open file:///C:/Users/me/clip.mp4');
  assert.equal(windows[0].needle, 'file:///C:/Users/me/clip.mp4');
  assert.equal(videoExtension(windows[0].path), 'mp4');
});

test('relative, non-video, quoted and embedded references stay ordinary text', () => {
  for (const text of [
    '@clip.mp4',
    '@/Users/me/notes.txt',
    'file:///Users/me/notes.txt',
    'mail me at user@example.com',
    'see (@/Users/me/clip.mp4)',
    'see `@/Users/me/clip.mp4`',
    'see [clip](file:///Users/me/clip.mp4)',
  ]) {
    assert.deepEqual(findVideoFileReferences(text), [], text);
  }
});

test('multiple references keep text order and exact trailing punctuation handling', () => {
  const text = 'first @/a/clip.mp4, then file:///b/clip.webm.';
  const references = findVideoFileReferences(text);
  assert.deepEqual(references.map(({ needle }) => needle), ['@/a/clip.mp4', 'file:///b/clip.webm']);
  assert.deepEqual([...references].sort((a, b) => a.offset - b.offset), references);
});
