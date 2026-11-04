import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertVideoCapability } from '../lib/capability.js';

test('a non-injectable route fails even when it declares video or image support', () => {
  for (const capability of [
    { provider: 'magpie', model: 'm', video: true, image: true, injectable: false, reason: 'provider-not-injectable' },
    { provider: 'magpie', model: 'm', video: false, image: true, injectable: false, reason: 'provider-not-injectable' },
  ]) {
    assert.throws(() => assertVideoCapability(capability), { code: 'VIDEO_UNSUPPORTED' });
  }
});

test('an injectable route with media capability passes', () => {
  const video = { provider: 'magpie', model: 'm', video: true, image: false, injectable: true, reason: 'native-video' };
  const image = { provider: 'magpie', model: 'm', video: false, image: true, injectable: true, reason: 'image-storyboard' };
  assert.equal(assertVideoCapability(video), video);
  assert.equal(assertVideoCapability(image), image);
});

test('an injectable route with neither capability fails', () => {
  assert.throws(
    () => assertVideoCapability({ provider: 'magpie', model: 'm', video: false, image: false, injectable: true, reason: 'no-media-capability' }),
    { code: 'VIDEO_UNSUPPORTED' },
  );
});
