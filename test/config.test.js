import test from 'node:test';
import assert from 'node:assert/strict';
import { countRequestWords, getRequestWordLimit, validateConfig } from '../src/config.js';
import { buildModulatedText } from '../src/expression.js';

const low = { id: 'gemini-2.5-flash-native-audio-preview-12-2025', name: 'Low Quality', wordLimit: 1000, characterLimit: 1000000, requiresLogin: false };
const balanced = { id: 'gemini-3.8-live', name: 'Balanced', wordLimit: 500, characterLimit: 65000, requiresLogin: true };
const enhanced = { id: 'gemini-3.8-live-extended-thinking', name: 'Enhanced Thinking', wordLimit: 250, characterLimit: 65000, requiresLogin: true, requiresAdmin: false };
const config = { configured: true, streaming: true, defaultModelId: low.id, modelId: low.id, guestWordLimit: 50, voices: ['Kore'], models: [low, balanced, enhanced], auth: { enabled: true, signedIn: false, admin: false }, user: null };

test('public streaming config does not require daily quota, plan, or admin entitlements', () => {
  assert.equal(validateConfig(config), config);
  assert.equal(validateConfig({ ...config, auth: { enabled: true, signedIn: true, admin: false }, user: { name: 'A', email: 'a@example.com' } }).models.length, 3);
  assert.equal(validateConfig({ ...config, auth: { enabled: true, signedIn: true, admin: true } }).models.length, 3);
  const withUsage = { ...config, usage: { words: 9000 } };
  assert.equal(validateConfig(withUsage), withUsage);
  const minimalModels = { ...config, models: config.models.map(({ name, ...model }) => model) };
  assert.equal(validateConfig(minimalModels), minimalModels);
});

test('catalog rejects invalid word limits and unrecognized default models', () => {
  assert.throws(() => validateConfig({ ...config, models: [{ ...low, wordLimit: 0 }] }), /invalid streaming model catalog/);
  assert.throws(() => validateConfig({ ...config, models: [{ ...low, wordLimit: Number.NaN }] }), /invalid streaming model catalog/);
  assert.throws(() => validateConfig({ ...config, guestWordLimit: 0 }), /invalid streaming model catalog/);
  assert.throws(() => validateConfig({ ...config, streaming: false }), /invalid streaming model catalog/);
  assert.throws(() => validateConfig({ ...config, defaultModelId: 'missing' }), /invalid default model/);
  assert.throws(() => validateConfig({ ...config, auth: { enabled: true, signedIn: false, admin: true } }), /invalid streaming model catalog/);
});

test('word counts include formatted expression tags and model switches update limits', () => {
  assert.equal(countRequestWords(buildModulatedText('Hello  world\nagain', 'Warm, Excited')), 4);
  assert.equal(countRequestWords(buildModulatedText('   ', '')), 0);
  assert.equal(getRequestWordLimit(low, config.auth, config.guestWordLimit), 50);
  const signedIn = { enabled: true, signedIn: true, admin: false };
  assert.equal(getRequestWordLimit(low, signedIn, config.guestWordLimit), 1000);
  assert.equal(getRequestWordLimit(balanced, signedIn, config.guestWordLimit), 500);
  assert.equal(getRequestWordLimit(enhanced, signedIn, config.guestWordLimit), 250);
  assert.equal(getRequestWordLimit(null, signedIn, config.guestWordLimit), null);
  const atGuestCap = buildModulatedText('word '.repeat(49).trim(), 'Warm');
  const overGuestCap = buildModulatedText('word '.repeat(50).trim(), 'Warm');
  assert.equal(countRequestWords(atGuestCap), 50);
  assert.equal(countRequestWords(overGuestCap), 51);
});

test('only a verified signed-in admin has no per-request word cap on every model', () => {
  const verifiedAdmin = validateConfig({ ...config, auth: { enabled: true, signedIn: true, admin: true } }).auth;
  for (const model of config.models) {
    assert.equal(getRequestWordLimit(model, verifiedAdmin, config.guestWordLimit), null, model.id);
    assert.equal(getRequestWordLimit(model, { enabled: true, signedIn: false, admin: true }, config.guestWordLimit), 50, model.id);
    assert.equal(getRequestWordLimit(model, { enabled: true, signedIn: true, admin: false }, config.guestWordLimit), model.wordLimit, model.id);
    assert.equal(getRequestWordLimit(model, { enabled: true, signedIn: true, admin: 'true' }, config.guestWordLimit), model.wordLimit, model.id);
  }
  assert.equal(getRequestWordLimit(null, verifiedAdmin, config.guestWordLimit), null);
});
