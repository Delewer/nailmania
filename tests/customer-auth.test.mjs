import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  clearSessionCookie,
  hashPassword,
  newSessionRecord,
  normalizeEmail,
  requireCustomerMutation,
  resolveCustomer,
  sessionCookie,
  verifyPassword,
} from '../functions/_lib/customer-auth.js';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';

const schema = [
  readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0005_customer_accounts.sql', import.meta.url), 'utf8'),
].join('\n');

test('customer password hashes use a unique salt and verify without storing plaintext', async () => {
  const first = await hashPassword('very long passphrase');
  const second = await hashPassword('very long passphrase');
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /very long passphrase/);
  assert.equal(await verifyPassword('very long passphrase', first), true);
  assert.equal(await verifyPassword('wrong password', first), false);
  assert.equal(await verifyPassword('wrong password', ''), false);
});

test('email normalization and same-origin JSON protection reject unsafe account requests', () => {
  assert.equal(normalizeEmail('  ANA@Example.COM '), 'ana@example.com');
  assert.throws(() => normalizeEmail('not-an-email'), (error) => error.code === 'INVALID_EMAIL');
  assert.throws(() => requireCustomerMutation(new Request('https://nailmania.md/api/me', {
    method: 'PATCH',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
  }), { ENVIRONMENT: 'production' }), (error) => error.code === 'CROSS_ORIGIN_REQUEST');
  assert.throws(() => requireCustomerMutation(new Request('https://nailmania.md/api/me', {
    method: 'PATCH',
    headers: { origin: 'https://nailmania.md', 'content-type': 'text/plain' },
  }), { ENVIRONMENT: 'production' }), (error) => error.code === 'JSON_REQUIRED');
});

test('opaque HttpOnly session resolves only an active unexpired customer', async (t) => {
  const db = new SqliteD1(schema);
  t.after(() => db.close());
  db.sqlite.prepare(`
    INSERT INTO users (id, email, name, role, status, password_hash)
    VALUES ('customer-1', 'ana@example.com', 'Ana', 'customer', 'active', 'not-returned')
  `).run();
  const request = new Request('http://127.0.0.1:8788/api/auth/login', {
    method: 'POST',
    headers: { 'user-agent': 'test browser', 'cf-connecting-ip': '127.0.0.1' },
  });
  const session = await newSessionRecord(db, 'customer-1', request, { ENVIRONMENT: 'local' });
  await session.statement.run();
  const cookie = sessionCookie(request, { ENVIRONMENT: 'local' }, session.token);
  assert.match(cookie, /^nm_session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=/);
  assert.doesNotMatch(cookie, /Secure/);

  const context = {
    request: new Request('http://127.0.0.1:8788/api/me', { headers: { cookie } }),
    env: { DB: db, ENVIRONMENT: 'local' },
  };
  const auth = await resolveCustomer(context, { required: true });
  assert.deepEqual(auth.user, {
    id: 'customer-1', email: 'ana@example.com', phone: '', name: 'Ana', role: 'customer', emailVerified: false,
  });
  assert.equal(db.sqlite.prepare('SELECT token_hash FROM sessions').get().token_hash.includes(session.token), false);

  db.sqlite.prepare("UPDATE users SET status = 'blocked' WHERE id = 'customer-1'").run();
  await assert.rejects(resolveCustomer(context, { required: true }), (error) => error.code === 'AUTH_REQUIRED');
  assert.match(clearSessionCookie(new Request('https://nailmania.md/api/auth/logout'), { ENVIRONMENT: 'production' }), /Max-Age=0; Secure/);
});
