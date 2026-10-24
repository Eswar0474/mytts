import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresDailyWordQuota, createMemoryDailyWordQuota } from '../server/quota.js';

function createFakePostgresPool() {
  const usage = new Map();
  const migrations = new Set();
  const calls = [];
  const query = async (sql, values = []) => {
      calls.push({ sql, values });
      if (sql.includes('pg_advisory_lock') || sql.includes('pg_advisory_unlock') ||
          sql.startsWith('CREATE TABLE IF NOT EXISTS sonora_schema_migrations') ||
          sql.startsWith('CREATE TABLE IF NOT EXISTS daily_word_usage') ||
          sql.startsWith('CREATE TABLE IF NOT EXISTS users') ||
          sql.startsWith('CREATE TABLE IF NOT EXISTS audio_jobs') ||
          sql.startsWith('-- Replace the former Google-account identity') ||
          sql.startsWith('ALTER TABLE users ADD COLUMN') ||
          sql.startsWith('ALTER TABLE users ALTER COLUMN email') ||
          sql.startsWith('ALTER TABLE daily_word_usage DROP CONSTRAINT') ||
          sql.includes('daily_word_usage_words_used_nonnegative') ||
          sql.includes('session') ||
          sql.startsWith('CREATE INDEX IF NOT EXISTS') ||
          sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('SELECT migration FROM sonora_schema_migrations')) {
        return { rows: migrations.has(values[0]) ? [{ migration: values[0] }] : [] };
      }
      if (sql.includes('INSERT INTO sonora_schema_migrations')) {
        migrations.add(values[0]);
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO daily_word_usage')) {
        assert.equal(values.length, 4);
        assert.doesNotMatch(sql, /\bWHERE daily_word_usage\.words_used/);
        const [day, subjectType, subjectHash, words] = values;
        const key = `${day}:${subjectType}:${subjectHash}`;
        const current = usage.get(key) ?? 0;
        const wordsUsed = current + words;
        usage.set(key, wordsUsed);
        return { rows: [{ words_used: wordsUsed }] };
      }
      if (sql.includes('SELECT words_used FROM daily_word_usage')) {
        const [day, subjectType, subjectHash] = values;
        const wordsUsed = usage.get(`${day}:${subjectType}:${subjectHash}`);
        return { rows: wordsUsed === undefined ? [] : [{ words_used: wordsUsed }] };
      }
      throw new Error(`Unexpected SQL query: ${sql}`);
  };
  const client = { query, release() {} };
  return {
    calls,
    query,
    async connect() { return client; }
  };
}

test('PostgreSQL usage accumulates atomically beyond former daily caps for accounts and guests', async () => {
  const pool = createFakePostgresPool();
  let currentTime = new Date('2026-10-12T12:00:00.000Z');
  const quota = createPostgresDailyWordQuota({
    pool,
    secret: 'stable-test-secret',
    now: () => currentTime
  });
  const secondInstance = createPostgresDailyWordQuota({
    pool,
    secret: 'stable-test-secret',
    now: () => currentTime
  });
  const userId = 'account-123';

  const first = await quota.recordFor('user', userId, 999);
  assert.deepEqual(first, { wordsUsed: 999, date: '2026-10-12' });
  const concurrent = await Promise.all([
    quota.recordFor('user', userId, 1),
    secondInstance.recordFor('user', userId, 2)
  ]);
  assert.deepEqual(concurrent.map(({ wordsUsed }) => wordsUsed).sort((a, b) => a - b), [1000, 1002]);
  assert.deepEqual(await secondInstance.getUsageFor('user', userId), { wordsUsed: 1002, date: '2026-10-12' });
  assert.deepEqual(await quota.getUsageFor('ip', userId), { wordsUsed: 0, date: '2026-10-12' });
  assert.equal((await quota.recordFor('ip', userId, 50)).wordsUsed, 50);
  assert.equal((await quota.recordFor('ip', userId, 50)).wordsUsed, 100);
  assert.equal((await quota.getUsageFor('ip', userId)).wordsUsed, 100);
  assert.ok(pool.calls.some(({ sql }) => sql.includes("CHECK (subject_type IN ('ip', 'user'))")));
  assert.ok(pool.calls.some(({ sql }) => sql.includes('daily_word_usage_words_used_nonnegative')));
  assert.ok(!pool.calls.some(({ sql }) => sql.startsWith('DELETE FROM daily_word_usage')));
  assert.ok(pool.calls.filter(({ sql }) => sql.includes('INSERT INTO daily_word_usage'))
    .every(({ values }) => values[2] !== userId && /^[a-f0-9]{64}$/.test(values[2])));

  currentTime = new Date('2026-10-13T00:00:00.000Z');
  assert.deepEqual(await quota.getUsageFor('user', userId), { wordsUsed: 0, date: '2026-10-13' });
  currentTime = new Date('2026-10-12T12:00:00.000Z');
  assert.equal((await quota.getUsageFor('user', userId)).wordsUsed, 1002);
});

test('PostgreSQL schema initialization succeeds when transaction poolers reject advisory locks', async () => {
  const pool = createFakePostgresPool();
  const innerClientQuery = (await pool.connect()).query;
  const poolClient = {
    release() {},
    query: async (sql, values) => {
      if (sql.includes('pg_advisory_lock')) {
        const error = new Error('pg_advisory_lock is not supported in transaction pooling mode');
        error.code = '0A000';
        throw error;
      }
      return innerClientQuery(sql, values);
    }
  };
  const poolerPool = {
    calls: pool.calls,
    query: pool.query,
    async connect() { return poolClient; }
  };
  const quota = createPostgresDailyWordQuota({
    pool: poolerPool,
    secret: 'pooler-test-secret',
    now: () => new Date('2026-10-12T12:00:00.000Z')
  });
  const result = await quota.getUsageFor('ip', '192.0.2.1');
  assert.deepEqual(result, { wordsUsed: 0, date: '2026-10-12' });
});

test('in-memory usage accumulates exactly beyond old caps and isolates subjects by day', async () => {
  let currentTime = new Date('2026-10-12T12:00:00.000Z');
  const usage = createMemoryDailyWordQuota({ secret: 'usage-test-secret', now: () => currentTime });
  assert.deepEqual(await usage.getUsageFor('user', 'account-1'), { wordsUsed: 0, date: '2026-10-12' });
  assert.equal((await usage.recordFor('ip', '192.0.2.1', 50)).wordsUsed, 50);
  assert.equal((await usage.recordFor('ip', '192.0.2.1', 50)).wordsUsed, 100);
  assert.deepEqual((await Promise.all([
    usage.recordFor('user', 'account-1', 1000),
    usage.recordFor('user', 'account-1', 500)
  ])).map(item => item.wordsUsed), [1000, 1500]);
  assert.equal((await usage.getUsageFor('user', 'account-1')).wordsUsed, 1500);
  assert.equal((await usage.getUsageFor('user', 'account-2')).wordsUsed, 0);
  assert.equal((await usage.getUsageFor('ip', '192.0.2.1')).wordsUsed, 100);
  currentTime = new Date('2026-10-13T00:00:00.000Z');
  assert.deepEqual(await usage.getUsageFor('user', 'account-1'), { wordsUsed: 0, date: '2026-10-13' });
  currentTime = new Date('2026-10-12T12:00:00.000Z');
  assert.equal((await usage.getUsageFor('user', 'account-1')).wordsUsed, 1500);
});
