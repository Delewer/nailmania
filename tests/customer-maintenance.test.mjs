import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanupCustomerAuthRecords } from '../functions/_lib/customer-maintenance.js';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';

const schema = [
  readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0005_customer_accounts.sql', import.meta.url), 'utf8'),
].join('\n');

test('customer-auth maintenance removes expired sessions and only aged reset records', async (t) => {
  const db = new SqliteD1(schema);
  t.after(() => db.close());
  db.sqlite.exec(`
    INSERT INTO users (id, email) VALUES ('user-1', 'user@example.test');
    INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked_at) VALUES
      ('expired', 'user-1', 'expired', '2026-07-15T00:00:00.000Z', NULL),
      ('old-revoked', 'user-1', 'old-revoked', '2026-12-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
      ('recent-revoked', 'user-1', 'recent-revoked', '2026-12-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z'),
      ('active', 'user-1', 'active', '2026-12-01T00:00:00.000Z', NULL);
    INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, used_at) VALUES
      ('aged-expired', 'user-1', 'aged-expired', '2026-07-01T00:00:00.000Z', NULL),
      ('recent-expired', 'user-1', 'recent-expired', '2026-07-15T00:00:00.000Z', NULL),
      ('aged-used', 'user-1', 'aged-used', '2026-12-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
      ('active-reset', 'user-1', 'active-reset', '2026-12-01T00:00:00.000Z', NULL);
  `);

  assert.deepEqual(await cleanupCustomerAuthRecords(db, {
    now: new Date('2026-07-16T10:00:00.000Z'),
  }), { sessionsDeleted: 2, resetTokensDeleted: 2 });
  assert.deepEqual(
    db.sqlite.prepare('SELECT id FROM sessions ORDER BY id').all().map((row) => row.id),
    ['active', 'recent-revoked'],
  );
  assert.deepEqual(
    db.sqlite.prepare('SELECT id FROM password_reset_tokens ORDER BY id').all().map((row) => row.id),
    ['active-reset', 'recent-expired'],
  );
});
