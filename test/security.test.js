import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApp, DEFAULT_MODEL_ID, securePostgresOptions, isRemotePostgresUrl } from '../server/index.js';
import { createMemoryDailyWordQuota } from '../server/quota.js';

async function serve(t, config = {}, synthesize = async () => Buffer.from([0, 0])) {
  const app = createApp({
    synthesize,
    config: { apiKey: 'test-only', model: DEFAULT_MODEL_ID, ...config },
    quotaStore: createMemoryDailyWordQuota({ secret: 'security-test-quota' }),
    logger: { warn() {}, error() {} }
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const request = (base, text = 'Hello.') => fetch(`${base}/api/generate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, model: DEFAULT_MODEL_ID, voice: 'Kore' })
});

const requestWithHost = base => new Promise((resolve, reject) => {
  const url = new URL(`${base}/api/config`);
  const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, headers: { Host: 'rebind.example' } }, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body }));
  });
  request.on('error', reject);
  request.end();
});

test('responses include browser security headers and reject an untrusted Host', async t => {
  const base = await serve(t);
  const config = await fetch(`${base}/api/config`);
  assert.equal(config.status, 200);
  assert.equal(config.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(config.headers.get('x-frame-options'), 'DENY');
  assert.equal(config.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(config.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const csp = config.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-eval'(?:\s|;|$)/);
  assert.doesNotMatch(config.headers.get('content-security-policy'), /script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(config.headers.get('content-security-policy'), /doubleclick|googlesyndication/);
  assert.equal(config.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(config.headers.get('cache-control'), 'no-store');

  const forgedHost = await requestWithHost(base);
  assert.equal(forgedHost.status, 403);
  assert.match(forgedHost.body, /Host is not allowed/);
});

test('generation retains a per-subject short-window rate limit', async t => {
  let calls = 0;
  const base = await serve(t, { generationRateLimit: 2, generationRateWindowMs: 60_000 }, async () => {
    calls++;
    return Buffer.from([0, 0]);
  });
  assert.equal((await request(base)).status, 200);
  assert.equal((await request(base, 'Again.')).status, 200);
  const limited = await request(base, 'Third.');
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('retry-after'), /^\d+$/);
  assert.match((await limited.json()).error, /Too many generation requests/);
  assert.equal(calls, 2);
});

test('production database URLs cannot explicitly disable TLS', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => createApp({
      config: { databaseUrl: 'postgresql://user:password@db.example/sonora?sslmode=disable' },
      logger: { warn() {}, error() {} }
    }), /PostgreSQL connections must use TLS/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('PostgreSQL uses TLS and can explicitly allow Render managed self-signed certificates', () => {
  const previous = process.env.DATABASE_SSL_CA;
  const previousVerification = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED;
  delete process.env.DATABASE_SSL_CA;
  delete process.env.DATABASE_SSL_REJECT_UNAUTHORIZED;
  try {
    assert.deepEqual(securePostgresOptions('postgres://db.example/sonora').ssl, { rejectUnauthorized: true });
    process.env.DATABASE_SSL_REJECT_UNAUTHORIZED = 'false';
    assert.deepEqual(securePostgresOptions('postgres://db.example/sonora').ssl, { rejectUnauthorized: false });
  } finally {
    if (previous === undefined) delete process.env.DATABASE_SSL_CA;
    else process.env.DATABASE_SSL_CA = previous;
    if (previousVerification === undefined) delete process.env.DATABASE_SSL_REJECT_UNAUTHORIZED;
    else process.env.DATABASE_SSL_REJECT_UNAUTHORIZED = previousVerification;
  }
});

test('isRemotePostgresUrl identifies Supabase / remote databases and preserves loopback', () => {
  assert.equal(isRemotePostgresUrl('postgresql://localhost:5432/sonora'), false);
  assert.equal(isRemotePostgresUrl('postgresql://127.0.0.1:5432/sonora'), false);
  assert.equal(isRemotePostgresUrl('postgresql://[::1]:5432/sonora'), false);
  assert.equal(isRemotePostgresUrl('postgresql://postgres.project:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres'), true);
  assert.equal(isRemotePostgresUrl('postgresql://postgres:secret@db.project.supabase.co:5432/postgres'), true);
  assert.equal(isRemotePostgresUrl('not-a-valid-url'), false);
});
