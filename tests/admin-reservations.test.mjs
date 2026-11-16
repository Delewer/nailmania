import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet as listReservations } from '../functions/api/admin/reservations/index.js';
import { fullSchema } from './helpers/full-schema.mjs';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';

function setup() {
  const db = new SqliteD1(fullSchema);
  db.sqlite.exec(`
    INSERT INTO users (id, email, name, role, status)
    VALUES ('manager-1', 'seller@example.test', 'Seller', 'manager', 'active');
    INSERT INTO categories (id, slug, name_ro, name_ru)
    VALUES ('test', 'test', 'Test', 'Test');
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, brand, name_ro, name_ru, price
    ) VALUES (1, 'P1', 'SKU-1', 'p1', 'test', 'Brand', 'Produs rezervat', 'Reserved product', 100);
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved)
    VALUES (1, 1, 5, 2);
    INSERT INTO orders (
      id, order_no, cart_id, status, language, customer_name, customer_phone,
      delivery_method, delivery_label, payment_method, payment_label,
      items_subtotal, catalog_discount, promo_discount, total_amount,
      reservation_expires_at, inventory_mode
    ) VALUES (
      'order-1', 'NM-NEW-1', '33333333-3333-4333-8333-333333333333', 'pending', 'ro',
      'Client Nou', '+37368000000', 'pickup', 'Ridicare', 'cash', 'Numerar',
      200, 0, 0, 200, NULL, 'reservation'
    );
    INSERT INTO order_items (
      order_id, product_id, product_key, sku, brand, name,
      unit_price, list_price, quantity, sold_quantity, line_total
    ) VALUES ('order-1', 1, 'P1', 'SKU-1', 'Brand', 'Produs rezervat', 100, 100, 2, 0, 200);
  `);
  return db;
}

function context(db, query = '') {
  return {
    env: {
      DB: db,
      ENVIRONMENT: 'local',
      ADMIN_DEV_TOKEN: 'test-secret',
      ADMIN_DEV_EMAIL: 'seller@example.test',
    },
    request: new Request(`http://127.0.0.1:8788/api/admin/reservations${query}`, {
      headers: { authorization: 'Bearer test-secret' },
    }),
  };
}

test('seller reservation page lists only stock reserved by open orders and has no countdown', async (t) => {
  const db = setup();
  t.after(() => db.close());

  const response = await listReservations(context(db));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.summary.openOrders, 1);
  assert.equal(payload.summary.reservedUnits, 2);
  assert.equal(payload.summary.activeReservations, 0);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].state, 'ordered');
  assert.equal(payload.items[0].expiresAt, null);
  assert.equal(payload.items[0].quantity, 2);
  assert.deepEqual(payload.items[0].inventory, { onHand: 5, reserved: 2, available: 3 });
  assert.equal(payload.items[0].order.no, 'NM-NEW-1');
  assert.equal(payload.items[0].order.customerName, 'Client Nou');

  const activeResponse = await listReservations(context(db, '?state=active'));
  assert.equal((await activeResponse.json()).items.length, 0);

  db.sqlite.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'order-1'");
  const cancelledResponse = await listReservations(context(db));
  const cancelledPayload = await cancelledResponse.json();
  assert.equal(cancelledPayload.summary.openOrders, 0);
  assert.equal(cancelledPayload.summary.reservedUnits, 0);
  assert.equal(cancelledPayload.items.length, 0);
});
