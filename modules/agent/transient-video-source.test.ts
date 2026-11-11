import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectTemporaryVideoAudioSource } from './model-tools.js';

const url = 'https://www.youtube.com/watch?v=abcdefghijk';
const request = { url };
const transient = { kind: 'remote-audio-temporary', url, sha256: 'a'.repeat(64),
  byteLength: 1048576, localRetained: false };

test('temporary video audio projects only frozen URL, digest and size without a persistent file reference', () => {
  const projected = projectTemporaryVideoAudioSource(transient, request);
  assert.deepEqual(projected, transient);
  assert.equal(Object.hasOwn(projected!, 'fileRefId'), false);
  assert.equal(projectTemporaryVideoAudioSource({
    fileRefId: 'original-subtitle-ref', fileRefVersion: 2, sha256: 'b'.repeat(64)
  }, request), null, 'native subtitles must continue through the existing registered-file proof');
});

test('temporary video source rejects changed URL, missing digest, invalid length and fake local persistence', () => {
  for (const input of [
    { ...transient, url: 'https://www.youtube.com/watch?v=other-video' },
    { ...transient, sha256: 'invalid' },
    { ...transient, byteLength: 0 },
    { ...transient, byteLength: Number.MAX_SAFE_INTEGER },
    { ...transient, localRetained: true },
    { ...transient, fileRefId: 'invented-permanent-file' },
  ]) {
    assert.throws(() => projectTemporaryVideoAudioSource(input, request),
      (error: unknown) => (error as { code?: string }).code === 'MODEL_ACTION_FAILED');
  }
  assert.throws(() => projectTemporaryVideoAudioSource(transient, { url: 'https://www.bilibili.com/video/BV1xxxx' }),
    (error: unknown) => (error as { code?: string }).code === 'MODEL_ACTION_FAILED');
  assert.throws(() => projectTemporaryVideoAudioSource(transient, {}),
    (error: unknown) => (error as { code?: string }).code === 'MODEL_ACTION_FAILED');
});

test('other media source forms never bypass existing persisted-file proof', () => {
  assert.equal(projectTemporaryVideoAudioSource({ kind: 'unknown', url }, request), null);
  assert.equal(projectTemporaryVideoAudioSource(null, request), null);
});
