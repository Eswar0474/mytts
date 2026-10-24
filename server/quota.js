import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const migrations = readdirSync(migrationsPath)
  .filter(file => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
  .sort()
  .map(name => ({ name, sql: readFileSync(path.join(migrationsPath, name), 'utf8') }));
const migrationLockId = 531_240_019;

async function initializeSchema(pool) {
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    try {
      await client.query('SELECT pg_advisory_lock($1)', [migrationLockId]);
      lockAcquired = true;
    } catch {
      // Supabase / PgBouncer / Supavisor transaction poolers (port 6543) do not support
      // session-level advisory locks. Proceed with idempotent DDL and transactional updates.
    }
    await client.query(
      `CREATE TABLE IF NOT EXISTS sonora_schema_migrations (
        migration TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );
    for (const migration of migrations) {
      const applied = await client.query(
        'SELECT migration FROM sonora_schema_migrations WHERE migration = $1',
        [migration.name]
      );
      if (applied.rows.length) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO sonora_schema_migrations (migration) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      if (lockAcquired) {
        await client.query('SELECT pg_advisory_unlock($1)', [migrationLockId]);
      }
    } catch {}
    client.release();
  }
}

export function createPostgresDailyWordQuota({ pool, secret, now = () => new Date() }) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL connection pool is required.');
  if (typeof secret !== 'string' || !secret) throw new TypeError('A stable usage hashing secret is required.');

  const ready = initializeSchema(pool);
  ready.catch(() => {});
  const today = () => now().toISOString().slice(0, 10);
  const hashedSubject = (type, value) => createHmac('sha256', secret)
    .update(`${type}:${String(value)}`)
    .digest('hex');
  const readUsage = async (subjectType, subjectHash, day) => {
    const result = await pool.query(
      'SELECT words_used FROM daily_word_usage WHERE usage_date = $1 AND subject_type = $2 AND subject_hash = $3',
      [day, subjectType, subjectHash]
    );
    return { wordsUsed: Number(result.rows[0]?.words_used ?? 0), date: day };
  };

  const getUsageFor = async (subjectType, subjectId) => {
    if (!['ip', 'user'].includes(subjectType) || subjectId == null || !String(subjectId)) throw new TypeError('Invalid usage subject.');
    await ready;
    const day = today();
    return readUsage(subjectType, hashedSubject(subjectType, subjectId), day);
  };
  const recordFor = async (subjectType, subjectId, words) => {
    if (!['ip', 'user'].includes(subjectType) || subjectId == null || !String(subjectId)) throw new TypeError('Invalid usage subject.');
    if (!Number.isSafeInteger(words) || words <= 0) throw new RangeError('Word usage must be a positive integer.');
    await ready;
    const day = today();
    const hash = hashedSubject(subjectType, subjectId);
    const result = await pool.query(
      `INSERT INTO daily_word_usage (usage_date, subject_type, subject_hash, words_used)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (usage_date, subject_type, subject_hash)
       DO UPDATE SET words_used = daily_word_usage.words_used + EXCLUDED.words_used
       RETURNING words_used`,
      [day, subjectType, hash, words]
    );
    if (!result.rows.length) throw new Error('Word usage could not be recorded.');
    return { wordsUsed: Number(result.rows[0].words_used), date: day };
  };
  return {
    ready,
    getUsageFor,
    recordFor,
    getUsage: ip => getUsageFor('ip', ip),
    record: (ip, words) => recordFor('ip', ip, words)
  };
}

export function createMemoryDailyWordQuota({ secret, now = () => new Date() }) {
  if (typeof secret !== 'string' || !secret) throw new TypeError('A usage hashing secret is required.');
  const usage = new Map();
  const keyFor = (type, subjectId, day) => `${day}:${createHmac('sha256', secret).update(`${type}:${String(subjectId)}`).digest('hex')}`;
  const snapshot = (type, subjectId) => {
    const day = now().toISOString().slice(0, 10);
    const key = keyFor(type, subjectId, day);
    return { key, wordsUsed: usage.get(key) ?? 0, date: day };
  };
  const getUsageFor = async (type, subjectId) => {
    if (!['ip', 'user'].includes(type) || subjectId == null || !String(subjectId)) throw new TypeError('Invalid usage subject.');
    const { wordsUsed, date } = snapshot(type, subjectId);
    return { wordsUsed, date };
  };
  const recordFor = async (type, subjectId, words) => {
    if (!['ip', 'user'].includes(type) || subjectId == null || !String(subjectId)) throw new TypeError('Invalid usage subject.');
    if (!Number.isSafeInteger(words) || words <= 0) throw new RangeError('Word usage must be a positive integer.');
    const current = snapshot(type, subjectId);
    const wordsUsed = current.wordsUsed + words;
    if (!Number.isSafeInteger(wordsUsed)) throw new RangeError('Word usage exceeds safe integer precision.');
    usage.set(current.key, wordsUsed);
    return { wordsUsed, date: current.date };
  };
  return {
    getUsageFor,
    recordFor,
    getUsage: ip => getUsageFor('ip', ip),
    record: (ip, words) => recordFor('ip', ip, words)
  };
}
