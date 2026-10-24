import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const PASSWORD_HASH_VERSION = 'scrypt';

export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 32;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;
export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/i;

export function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function validateUsername(value) {
  const username = normalizeUsername(value);
  if (username.length < MIN_USERNAME_LENGTH || username.length > MAX_USERNAME_LENGTH || !USERNAME_PATTERN.test(username)) {
    throw new Error(`Username must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters and use only letters, numbers, dots, underscores, or hyphens.`);
  }
  return username;
}

export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`);
  }
  return value;
}

export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY
  });
  return [
    PASSWORD_HASH_VERSION,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    Buffer.from(derived).toString('base64url')
  ].join('$');
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const [version, n, r, p, saltValue, hashValue] = encoded.split('$');
  if (version !== PASSWORD_HASH_VERSION || n !== String(SCRYPT_N) || r !== String(SCRYPT_R) ||
      p !== String(SCRYPT_P) || !saltValue || !hashValue) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltValue, 'base64url');
    expected = Buffer.from(hashValue, 'base64url');
  } catch {
    return false;
  }
  if (salt.length < 16 || expected.length !== SCRYPT_KEY_LENGTH) return false;
  try {
    const actual = Buffer.from(await scrypt(password, salt, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAX_MEMORY
    }));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function publicUser(user) {
  if (!user || typeof user.username !== 'string') return null;
  return {
    username: user.username,
    name: user.name || user.username
  };
}
