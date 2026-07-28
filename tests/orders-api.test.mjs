import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onRequestPost as createOrder } from '../functions/api/orders.js';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';
import { withOrderContract } from './helpers/order-fixture.mjs';

const schema = [
  readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0002_order_transitions.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0003_admin_products.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0006_returns_and_admin_journals.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0007_catalog_cache.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0009_promotions.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0010_statistics_and_analytics.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0011_notifications_and_order_operations.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0012_order_idempotency.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0013_order_commercial_snapshot_guard.sql', import.meta.url), 'utf8'),
].join('\n');

function setup() {
  const db = new SqliteD1(schema);
  db.sqlite.prepare(`
    INSERT INTO categories (id, slug, name_ro, name_ru)
    VALUES ('test', 'test', 'Test', 'Test')
  `).run();
  db.sqlite.prepare(`
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, brand, name_ro, name_ru,
      price, old_price, admin_revision
    ) VALUES (1, 'ORDER-001', 'ORDER-001', 'order-001', 'test', 'Test',
              'Produs', 'Product', 100, 0, 'product:initial')
  `).run();
  db.sqlite.prepare(`
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, admin_revision)
    VALUES (1, 1, 5, 0, 'inventory:initial')
  `).run();
  return db;
}

test('creating an order advances the inventory revision with the reservation', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const analyticsPoints = [];
  const env = {
    DB: db,
    ENVIRONMENT: 'local',
    ANALYTICS_INDEX_SECRET: 'test-analytics-index-secret',
    PRODUCT_ANALYTICS: { writeDataPoint: (point) => analyticsPoints.push(point) },
  };
  const response = await createOrder({
    env,
    request: new Request('https://example.test/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(withOrderContract(db, {
        items: [{ productKey: 'ORDER-001', quantity: 2 }],
        customer: { name: 'Ana Test', phone: '+37368000000' },
        delivery: 'pickup',
        payment: 'cash',
        lang: 'ro',
      })),
    }),
  });

  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.deepEqual(
    { ...db.sqlite.prepare(`
      SELECT on_hand, reserved, admin_revision FROM inventory WHERE product_id = 1
    `).get() },
    { on_hand: 5, reserved: 2, admin_revision: `order:${payload.order.id}:reservation` },
  );
  assert.deepEqual(
    { ...db.sqlite.prepare(`
      SELECT movement_type, delta_reserved, balance_on_hand, balance_reserved
      FROM inventory_movements WHERE order_id = ?
    `).get(payload.order.id) },
    { movement_type: 'reservation', delta_reserved: 2, balance_on_hand: 5, balance_reserved: 2 },
  );
  assert.deepEqual(
    { ...db.sqlite.prepare(`
      SELECT category_id_snapshot, category_name_ro_snapshot,
             category_name_ru_snapshot, cost_price_snapshot
      FROM order_items WHERE order_id = ?
    `).get(payload.order.id) },
    {
      category_id_snapshot: 'test',
      category_name_ro_snapshot: 'Test',
      category_name_ru_snapshot: 'Test',
      cost_price_snapshot: null,
    },
  );
  assert.equal(analyticsPoints.length, 1);
  assert.deepEqual(analyticsPoints[0].blobs, ['order_created', '', '', '', 'ro', 'checkout']);
  assert.deepEqual(analyticsPoints[0].doubles, [1, 2, 200, 0, 0]);
  assert.equal(analyticsPoints[0].indexes.length, 1);

  const rejected = await createOrder({
    env,
    request: new Request('https://example.test/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(withOrderContract(db, {
        items: [{ productKey: 'ORDER-001', quantity: 99 }],
        customer: { name: 'Ana Test', phone: '+37368000000' },
        delivery: 'pickup', payment: 'cash', lang: 'ro',
      })),
    }),
  });
  assert.equal(rejected.status, 409);
  assert.equal(analyticsPoints.length, 1, 'a rejected order must not emit order_created');
});
