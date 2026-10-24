import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidStreamStart } from '../src/stream-client.js';

test('stream starts require audio dimensions, never a usage or quota payload', () => {
  assert.equal(isValidStreamStart({ type: 'start', sampleRate: 24000, totalChunks: 1 }), true);
  assert.equal(isValidStreamStart({ type: 'start', sampleRate: 24000, totalChunks: 2, usage: null }), true);
  assert.equal(isValidStreamStart({ type: 'start', sampleRate: 24000, totalChunks: 1, usage: { used: 'informational' } }), true);
  assert.equal(isValidStreamStart({ type: 'start', sampleRate: 44100, totalChunks: 1 }), false);
  assert.equal(isValidStreamStart({ type: 'start', sampleRate: 24000, totalChunks: 0 }), false);
  assert.equal(isValidStreamStart({ type: 'done', sampleRate: 24000, totalChunks: 1 }), false);
});
