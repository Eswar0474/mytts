import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_AUDIO_BYTES as SERVER_AUDIO_BYTES,
  MAX_STREAM_WIRE_BYTES as SERVER_WIRE_BYTES,
  decodeBase64PCM as decodeServerPCM
} from '../server/index.js';
import {
  MAX_AUDIO_BYTES as CLIENT_AUDIO_BYTES,
  MAX_STREAM_WIRE_BYTES as CLIENT_WIRE_BYTES,
  SAMPLE_RATE,
  decodeBase64PCM as decodeClientPCM
} from '../src/audio.js';

test('server and browser retain matching PCM and base64-aware transport safety budgets', () => {
  assert.equal(SERVER_AUDIO_BYTES, 128 * 1024 * 1024);
  assert.equal(CLIENT_AUDIO_BYTES, SERVER_AUDIO_BYTES);
  assert.equal(SERVER_WIRE_BYTES, Math.ceil(SERVER_AUDIO_BYTES / 3) * 4 + 4 * 1024 * 1024);
  assert.equal(CLIENT_WIRE_BYTES, SERVER_WIRE_BYTES);
  assert.equal(SAMPLE_RATE, 24_000);
});

test('server and browser PCM decoders accept the byte boundary and reject overflow', () => {
  const pcm = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);
  const base64 = pcm.toString('base64');
  for (const decode of [decodeServerPCM, decodeClientPCM]) {
    assert.deepEqual([...decode(base64, pcm.length)], [...pcm]);
    assert.throws(() => decode(base64, pcm.length - 2), /PCM|base64/);
  }
});
