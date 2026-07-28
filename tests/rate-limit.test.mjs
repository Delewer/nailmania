import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cleanupExpiredRateLimits,
  enforceRateLimit,
  rateLimitRule,
} from '../functions/_lib/rate-limit.js';
import { onRequest } from '../functions/_middleware.js';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';

const schema = readFileSync(new URL('../migrations/0008_rate_limits.sql', import.meta.url), 'utf8');

const request = (ip = '203.0.113.9') => new Request('https://nailmania.md/api/auth/login', {
  method: 'POST',
  headers: { 'cf-connecting-ip': ip },
});

test('rate limits increment atomically per salted identity and reset by time window', async (t) => {
  const db = new SqliteD1(schema);
  t.after(() => db.close());
  const env = { ENVIRONMENT: 'production', RATE_LIMIT_SECRET: 'a-long-independent-test-secret' };
  const now = new Date('2026-07-16T12:00:00.000Z');
  const options = { db, env, scope: 'auth.login', limit: 2, windowSeconds: 60, now };

  assert.equal((await enforceRateLimit({ ...options, request: request() })).hits, 1);
  assert.equal((await enforceRateLimit({ ...options, request: request() })).hits, 2);
  await assert.rejects(
    enforceRateLimit({ ...options, request: request() }),
    (error) => error.code === 'RATE_LIMITED' && error.status === 429 && error.retryAfter === 60,
  );
  assert.equal((await enforceRateLimit({
    ...options,
    request: request('203.0.113.10'),
  })).hits, 1);
  assert.equal((await enforceRateLimit({
    ...options,
    request: request(),
    now: new Date('2026-07-16T12:01:00.000Z'),
  })).hits, 1);

  const stored = db.sqlite.prepare('SELECT key_hash FROM rate_limit_buckets LIMIT 1').get().key_hash;
  assert.match(stored, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(stored, /203\.0\.113/);
});

test('sensitive routes have explicit rules and production fails closed without its secret', async () => {
  assert.equal(rateLimitRule(request()).scope, 'auth.login');
  await assert.rejects(
    enforceRateLimit({
      db: { prepare() { throw new Error('must not reach DB'); } },
      request: request(),
      env: { ENVIRONMENT: 'production' },
      scope: 'auth.login',
      limit: 1,
      windowSeconds: 60,
    }),
    (error) => error.code === 'RATE_LIMIT_NOT_CONFIGURED' && error.status === 503,
  );
});

test('Pages middleware returns 429 with request correlation and Retry-After', async (t) => {
  const db = new SqliteD1(schema);
  t.after(() => db.close());
  const context = () => ({
    request: new Request('https://nailmania.md/api/orders', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.12' },
    }),
    env: { DB: db, ENVIRONMENT: 'production', RATE_LIMIT_SECRET: 'another-long-test-secret' },
    data: {},
    next: async () => Response.json({ ok: true }),
  });
  for (let index = 0; index < 12; index += 1) assert.equal((await onRequest(context())).status, 200);
  const response = await onRequest(context());
  const body = await response.json();

  assert.equal(response.status, 429);
  assert.match(response.headers.get('retry-after'), /^\d+$/);
  assert.equal(body.error.code, 'RATE_LIMITED');
  assert.equal(body.error.requestId, response.headers.get('x-request-id'));
});

test('scheduled cleanup removes only expired rate-limit buckets', async (t) => {
  const db = new SqliteD1(schema);
  t.after(() => db.close());
  db.sqlite.exec(`
    INSERT INTO rate_limit_buckets (scope, key_hash, window_start, hits, expires_at)
    VALUES
      ('expired', 'old', 1, 1, 100),
      ('current', 'new', 2, 1, 201);
  `);

  assert.deepEqual(
    await cleanupExpiredRateLimits(db, { now: new Date(200 * 1000) }),
    { deleted: 1 },
  );
  assert.deepEqual(
    db.sqlite.prepare('SELECT scope FROM rate_limit_buckets ORDER BY scope').all().map((row) => row.scope),
    ['current'],
  );
});
