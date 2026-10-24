import test from 'node:test';
import assert from 'node:assert/strict';
import { asError, errorMessage } from '../src/export-errors.js';

test('export errors preserve worker string failures for the UI', () => {
  assert.equal(errorMessage('WebAssembly compilation was blocked by Content Security Policy.'), 'WebAssembly compilation was blocked by Content Security Policy.');
  assert.equal(errorMessage(new Error('FFmpeg failed to load.')), 'FFmpeg failed to load.');
  assert.equal(errorMessage('', 'fallback'), 'fallback');
  assert.equal(asError('worker failed', 'fallback').message, 'worker failed');
  assert.equal(asError(null, 'fallback').message, 'fallback');
});
