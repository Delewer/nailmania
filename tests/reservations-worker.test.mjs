import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';
import worker from '../workers/reservations.js';

const schema = [
  readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0002_order_transitions.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0003_admin_products.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0005_customer_accounts.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0006_returns_and_admin_journals.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0007_catalog_cache.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0008_rate_limits.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0009_promotions.sql', import.meta.url), 'utf8'),
].join('\n');

function setupExpiredOrder() {
  const db = new SqliteD1(schema);
  db.sqlite.exec(`
    INSERT INTO categories (id, slug, name_ro, name_ru)
    VALUES ('test', 'test', 'Test', 'Test');

    INSERT INTO products (id, catalog_key, sku, slug, category_id, name_ro, price)
    VALUES (1, 'P1', 'P1', 'p-1', 'test', 'Product 1', 100);

    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved)
    VALUES (1, 1, 1, 1);

    INSERT INTO orders (
      id, order_no, status, language, customer_name, customer_phone,
      delivery_method, delivery_label, payment_method, payment_label,
      items_subtotal, total_amount, reservation_expires_at
    ) VALUES (
      'expired', 'NM-EXPIRED', 'pending', 'ro', 'Test Client', '+37360000000',
      'pickup', 'Pickup', 'cash', 'Cash', 100, 100, '2026-07-15T00:00:00.000Z'
    );

    INSERT INTO order_items (
      order_id, product_id, product_key, sku, name,
      unit_price, list_price, quantity, line_total
    ) VALUES ('expired', 1, 'P1', 'P1', 'Product 1', 100, 100, 1, 100);

    INSERT INTO inventory_movements (
      id, product_id, warehouse_id, movement_type, delta_reserved,
      balance_on_hand, balance_reserved, order_id, reason
    ) VALUES ('reserve:expired:1', 1, 1, 'reservation', 1, 1, 1, 'expired', 'Test');

    INSERT INTO rate_limit_buckets (scope, key_hash, window_start, hits, expires_at)
    VALUES
      ('expired', 'old', 1, 1, 100),
      ('current', 'new', 2, 1, 2000000000);

    INSERT INTO users (id, email, name) VALUES ('customer-1', 'customer@example.test', 'Customer');
    INSERT INTO sessions (
      id, user_id, token_hash, expires_at, last_used_at, created_at, revoked_at
    ) VALUES
      ('expired-session', 'customer-1', 'expired-token', '2026-07-15T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', NULL),
      ('active-session', 'customer-1', 'active-token', '2026-08-15T00:00:00.000Z', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z', NULL);
    INSERT INTO password_reset_tokens (
      id, user_id, token_hash, expires_at, used_at, created_at
    ) VALUES
      ('old-reset', 'customer-1', 'old-reset-token', '2026-07-01T00:00:00.000Z', NULL, '2026-06-30T00:00:00.000Z'),
      ('recent-reset', 'customer-1', 'recent-reset-token', '2026-07-16T11:00:00.000Z', NULL, '2026-07-16T09:00:00.000Z');
  `);
  return db;
}

test('scheduled worker entrypoint releases an expired reservation', async (t) => {
  const db = setupExpiredOrder();
  t.after(() => db.close());

  await worker.scheduled({
    cron: '*/5 * * * *',
    scheduledTime: Date.parse('2026-07-16T10:00:00.000Z'),
  }, { DB: db });

  assert.equal(db.sqlite.prepare("SELECT status FROM orders WHERE id = 'expired'").get().status, 'cancelled');
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = 1').get() },
    { on_hand: 1, reserved: 0 },
  );
  assert.equal(
    db.sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_movements WHERE movement_type = 'reservation_release'").get().count,
    1,
  );
  assert.deepEqual(
    db.sqlite.prepare('SELECT scope FROM rate_limit_buckets ORDER BY scope').all().map((row) => row.scope),
    ['current'],
  );
  assert.deepEqual(
    db.sqlite.prepare('SELECT id FROM sessions ORDER BY id').all().map((row) => row.id),
    ['active-session'],
  );
  assert.deepEqual(
    db.sqlite.prepare('SELECT id FROM password_reset_tokens ORDER BY id').all().map((row) => row.id),
    ['recent-reset'],
  );
});

test('scheduled worker entrypoint fails clearly without its D1 binding', async () => {
  await assert.rejects(
    worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *' }, {}),
    /D1 binding DB is not configured/,
  );
});
