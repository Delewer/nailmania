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
    VALUES (1, 1, 5, 3);
    INSERT INTO orders (
      id, order_no, cart_id, status, language, customer_name, customer_phone,
      delivery_method, delivery_label, payment_method, payment_label,
      items_subtotal, catalog_discount, promo_discount, total_amount
    ) VALUES (
      'order-1', 'NM-NEW-1', '33333333-3333-4333-8333-333333333333', 'pending', 'ro',
      'Client Nou', '+37368000000', 'pickup', 'Ridicare', 'cash', 'Numerar', 100, 0, 0, 100
    );
    INSERT INTO cart_reservations (
      id, cart_id, product_id, quantity, status, expires_at, created_at, updated_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 2, 'ACTIVE',
      '2099-01-01T00:15:00.000Z', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
    );
    INSERT INTO cart_reservations (
      id, cart_id, product_id, quantity, status, expires_at, created_at, updated_at
    ) VALUES (
      '22222222-2222-4222-8222-222222222222',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, 1, 'ACTIVE',
      '2020-01-01T00:15:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'
    );
    INSERT INTO cart_reservations (
      id, cart_id, product_id, quantity, status, expires_at, order_id, created_at, updated_at
    ) VALUES (
      '33333333-3333-4333-8333-333333333333',
      '33333333-3333-4333-8333-333333333333', 1, 1, 'CONVERTED',
      '2099-01-01T00:15:00.000Z', 'order-1',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );
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

test('seller reservation page lists active carts and newly converted orders but excludes expired holds', async (t) => {
  const db = setup();
  t.after(() => db.close());

  const response = await listReservations(context(db));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.summary, {
    activeReservations: 1,
    activeUnits: 2,
    recentOrders: 1,
    recentOrderedUnits: 1,
  });
  assert.equal(payload.items.length, 2);
  const active = payload.items.find((item) => item.state === 'active');
  const ordered = payload.items.find((item) => item.state === 'ordered');
  assert.equal(active.quantity, 2);
  assert.deepEqual(active.inventory, { onHand: 5, reserved: 2, available: 3 });
  assert.equal(ordered.order.no, 'NM-NEW-1');
  assert.equal(ordered.order.customerName, 'Client Nou');

  const orderedResponse = await listReservations(context(db, '?state=ordered&q=NM-NEW'));
  const orderedPayload = await orderedResponse.json();
  assert.equal(orderedResponse.status, 200);
  assert.equal(orderedPayload.items.length, 1);
  assert.equal(orderedPayload.items[0].state, 'ordered');
});
