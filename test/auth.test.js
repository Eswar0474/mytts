import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, normalizeUsername, validatePassword, validateUsername, verifyPassword } from '../server/auth.js';

test('local account credentials normalize and enforce safe boundaries', () => {
  assert.equal(normalizeUsername('  Alice_Name  '), 'alice_name');
  assert.equal(validateUsername('alice-name_1'), 'alice-name_1');
  assert.throws(() => validateUsername('ab'), /Username must be/);
  assert.throws(() => validateUsername('-bad'), /Username must be/);
  assert.throws(() => validatePassword('short'), /Password must be/);
  assert.equal(validatePassword('correct-horse-battery'), 'correct-horse-battery');
});

test('password hashes are salted and verify without exposing the password', async () => {
  const first = await hashPassword('correct-horse-battery');
  const second = await hashPassword('correct-horse-battery');
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$/);
  assert.equal(await verifyPassword('correct-horse-battery', first), true);
  assert.equal(await verifyPassword('wrong-password', first), false);
  assert.equal(await verifyPassword('correct-horse-battery', 'not-a-hash'), false);
});
