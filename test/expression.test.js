import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModulatedText } from '../src/expression.js';

test('comma-separated custom expression tags are bracketed and prepended', () => {
  assert.equal(buildModulatedText('Hello.', 'Warm, excited, whispering'), '[Warm][excited][whispering] Hello.');
});
test('empty tags are ignored and already bracketed tags are not double-wrapped', () => {
  assert.equal(buildModulatedText('Hello.', ' [Warm], , [calm] '), '[Warm][calm] Hello.');
  assert.equal(buildModulatedText('Hello.', ''), 'Hello.');
});
