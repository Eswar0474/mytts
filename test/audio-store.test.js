import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioStore, nextSessionId } from '../src/audio-store.js';

test('audio store waits for fire-and-forget chunks before building WAV', async () => {
  const store = createAudioStore(nextSessionId());
  store.appendChunk(Uint8Array.from([1, 0]));
  store.appendChunk(Uint8Array.from([2, 0]));

  const wav = await store.buildWav();
  assert.deepEqual([...wav.slice(44)], [1, 0, 2, 0]);
  await store.clear();
});
