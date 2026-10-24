import test from 'node:test';
import assert from 'node:assert/strict';
import { getAvailability } from '../src/availability.js';
import { countRequestWords, getRequestWordLimit } from '../src/config.js';
import { buildModulatedText } from '../src/expression.js';

const ready = { configStatus: 'ready', configured: true, voices: ['Kore', 'Puck'], generating: false, selectedModel: { id: 'low', requiresLogin: false }, voice: 'Kore', text: 'Hello.', overWordLimit: false, overCharacterLimit: false, wordLimit: 50, signedIn: false };
test('voices stay selectable when credentials are missing, generation explains setup', () => {
  const state = getAvailability({ ...ready, configured: false });
  assert.equal(state.voiceDisabled, false);
  assert.equal(state.generateDisabled, true);
  assert.match(state.reason, /GEMINI_API_KEY/);
});
test('valid configured input enables generation', () => {
  assert.equal(getAvailability(ready).generateDisabled, false);
});
test('empty input, limits, loading, and active requests explain disabled controls', () => {
  for (const overrides of [{ text: '  ' }, { overCharacterLimit: true }, { configStatus: 'loading' }, { generating: true }, { voice: '' }]) {
    const state = getAvailability({ ...ready, ...overrides });
    assert.equal(state.generateDisabled, true);
    assert.ok(state.reason.length);
  }
  assert.equal(getAvailability({ ...ready, generating: true }).voiceDisabled, true);
  assert.equal(getAvailability({ ...ready, voices: [] }).voiceDisabled, true);
});

test('request word overflow blocks generation with actionable guest and signed-in guidance', () => {
  const guest = getAvailability({ ...ready, overWordLimit: true });
  assert.equal(guest.generateDisabled, true);
  assert.match(guest.reason, /50 words per request.*sign in/i);

  const signedIn = getAvailability({ ...ready, signedIn: true, wordLimit: 500, overWordLimit: true });
  assert.equal(signedIn.generateDisabled, true);
  assert.match(signedIn.reason, /500 words.*including tags/i);
});

test('Balanced and Enhanced Thinking require sign-in, never admin or a plan', () => {
  for (const id of ['balanced', 'enhanced']) {
    const model = { id, requiresLogin: true, requiresAdmin: false };
    const guest = getAvailability({ ...ready, selectedModel: model });
    assert.equal(guest.generateDisabled, true);
    assert.match(guest.reason, /sign in/i);
    assert.equal(getAvailability({ ...ready, selectedModel: model, signedIn: true }).generateDisabled, false);
  }
});

test('signed-in admins can generate above each model word cap while signed-out admin flags cannot', () => {
  const text = 'word '.repeat(1001).trim();
  const requestText = buildModulatedText(text, 'Warm');
  const count = countRequestWords(requestText);
  for (const model of [
    { id: 'low', wordLimit: 1000, requiresLogin: false },
    { id: 'balanced', wordLimit: 500, requiresLogin: true },
    { id: 'enhanced', wordLimit: 250, requiresLogin: true }
  ]) {
    assert.ok(count > model.wordLimit);
    const adminLimit = getRequestWordLimit(model, { signedIn: true, admin: true }, 50);
    assert.equal(adminLimit, null);
    assert.equal(getAvailability({ ...ready, text, selectedModel: model, signedIn: true, wordLimit: adminLimit, overWordLimit: count > model.wordLimit }).generateDisabled, false);

    const guestLimit = getRequestWordLimit(model, { signedIn: false, admin: true }, 50);
    const guest = getAvailability({ ...ready, text, selectedModel: model, signedIn: false, wordLimit: guestLimit, overWordLimit: count > guestLimit });
    assert.equal(guest.generateDisabled, true);
    assert.match(guest.reason, model.requiresLogin ? /sign in/i : /50 words/i);
  }
});

test('admin word exemption cannot bypass character safety, configuration, busy, or empty checks', () => {
  const admin = { ...ready, signedIn: true, wordLimit: null, overWordLimit: true };
  assert.equal(getAvailability(admin).generateDisabled, false);
  for (const [overrides, expected] of [
    [{ overCharacterLimit: true }, /character safety limit.*character cap/i],
    [{ configStatus: 'error' }, /valid server configuration/i],
    [{ configured: false }, /backend setup required/i],
    [{ generating: true }, /in progress/i],
    [{ text: '  ' }, /write your script/i],
    [{ voice: '' }, /select an engine and voice/i],
    [{ selectedModel: null }, /select an engine and voice/i]
  ]) {
    const state = getAvailability({ ...admin, ...overrides });
    assert.equal(state.generateDisabled, true);
    assert.match(state.reason, expected);
  }
});
