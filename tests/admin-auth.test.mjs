import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AdminAuthError,
  requireAdmin,
  requireSameOrigin,
} from '../functions/_lib/admin-auth.js';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';

const schema = [
  readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0002_order_transitions.sql', import.meta.url), 'utf8'),
].join('\n');

function setupUser(options = {}) {
  const db = new SqliteD1(schema);
  db.sqlite.prepare(`
    INSERT INTO users (id, email, name, role, status)
    VALUES ('admin-1', 'admin@example.test', 'Test Administrator', ?, ?)
  `).run(options.role || 'admin', options.status || 'active');
  return db;
}

function context(db, token = 'test-secret') {
  return {
    request: new Request('http://127.0.0.1:8788/api/admin/session', {
      headers: { authorization: `Bearer ${token}` },
    }),
    env: {
      DB: db,
      ENVIRONMENT: 'local',
      ADMIN_DEV_TOKEN: 'test-secret',
      ADMIN_DEV_EMAIL: 'ADMIN@example.test',
    },
  };
}

test('local admin token resolves an active D1 administrator', async (t) => {
  const db = setupUser();
  t.after(() => db.close());

  const result = await requireAdmin(context(db));

  assert.equal(result.identity.email, 'admin@example.test');
  assert.equal(result.identity.source, 'local');
  assert.equal(result.user.id, 'admin-1');
  assert.equal(result.user.role, 'admin');
});

test('local admin authentication rejects an invalid bearer token', async (t) => {
  const db = setupUser();
  t.after(() => db.close());

  await assert.rejects(
    requireAdmin(context(db, 'wrong-secret')),
    (error) => error instanceof AdminAuthError
      && error.code === 'ADMIN_AUTH_REQUIRED'
      && error.status === 401,
  );
});

test('local bearer authentication is disabled outside the local environment', async (t) => {
  const db = setupUser();
  t.after(() => db.close());
  const productionContext = context(db);
  delete productionContext.env.ENVIRONMENT;

  await assert.rejects(
    requireAdmin(productionContext),
    (error) => error instanceof AdminAuthError
      && error.code === 'ADMIN_AUTH_NOT_CONFIGURED'
      && error.status === 503,
  );
});

test('D1 role and account status are enforced after authentication', async (t) => {
  const customerDb = setupUser({ role: 'customer' });
  const blockedDb = setupUser({ status: 'blocked' });
  t.after(() => customerDb.close());
  t.after(() => blockedDb.close());

  for (const db of [customerDb, blockedDb]) {
    await assert.rejects(
      requireAdmin(context(db)),
      (error) => error instanceof AdminAuthError
        && error.code === 'ADMIN_FORBIDDEN'
        && error.status === 403,
    );
  }
});

test('administrative mutations accept only the request origin', () => {
  assert.doesNotThrow(() => requireSameOrigin(new Request('https://admin.nailmania.md/api/admin/orders/1', {
    headers: { origin: 'https://admin.nailmania.md' },
  }), { ENVIRONMENT: 'production' }));
  assert.throws(
    () => requireSameOrigin(new Request('https://admin.nailmania.md/api/admin/orders/1', {
      headers: { origin: 'https://evil.example' },
    }), { ENVIRONMENT: 'production' }),
    (error) => error instanceof AdminAuthError
      && error.code === 'CROSS_ORIGIN_REQUEST'
      && error.status === 403,
  );
  assert.throws(
    () => requireSameOrigin(
      new Request('https://admin.nailmania.md/api/admin/orders/1'),
      { ENVIRONMENT: 'production' },
    ),
    (error) => error instanceof AdminAuthError
      && error.code === 'CROSS_ORIGIN_REQUEST'
      && error.status === 403,
  );
  assert.doesNotThrow(() => requireSameOrigin(
    new Request('http://127.0.0.1:8788/api/admin/orders/1'),
    { ENVIRONMENT: 'local' },
  ));
});
