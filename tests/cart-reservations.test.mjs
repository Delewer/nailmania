import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { onRequestGet as getCartCompatibility, onRequestPost as updateCartCompatibility } from '../functions/api/reservations.js';
import { onRequestPost as createOrder } from '../functions/api/orders.js';
import { fullSchema } from './helpers/full-schema.mjs';
import { withOrderContract } from './helpers/order-fixture.mjs';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';

const CART_ID = '11111111-1111-4111-8111-111111111111';

function setup(schema = fullSchema) {
  const db = new SqliteD1(schema);
  db.sqlite.exec(`
    INSERT INTO categories (id, slug, name_ro, name_ru)
    VALUES ('test', 'test', 'Test', 'Test');
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, brand, name_ro, name_ru, price
    ) VALUES (1, 'P1', 'SKU-1', 'p1', 'test', 'Brand', 'Produs', 'Товар', 100);
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved)
    VALUES (1, 1, 3, 0);
  `);
  return db;
}

const orderBody = (db) => withOrderContract(db, {
  cartId: CART_ID,
  items: [{ productKey: 'P1', quantity: 2 }],
  customer: { name: 'Ana Test', phone: '+37368000000' },
  delivery: 'pickup',
  payment: 'cash',
  lang: 'ro',
});

test('cart compatibility endpoint never reserves inventory or starts a timer', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const response = await updateCartCompatibility({
    env: { DB: db, ENVIRONMENT: 'local' },
    request: new Request('http://127.0.0.1:8788/api/reservations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cartId: CART_ID, productKey: 'P1', quantity: 2 }),
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.reservation.status, 'CART_ONLY');
  assert.equal(payload.reservation.expiresAt, null);
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = 1').get() },
    { on_hand: 3, reserved: 0 },
  );
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM cart_reservations').get().count, 0);

  const lookup = await getCartCompatibility({
    env: { DB: db, ENVIRONMENT: 'local' },
    request: new Request(`http://127.0.0.1:8788/api/reservations?cartId=${CART_ID}`),
  });
  assert.deepEqual((await lookup.json()).reservations, []);
});

test('placing an order reserves stock once without selling it or requiring a cart hold', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const body = orderBody(db);
  const response = await createOrder({
    env: { DB: db, ENVIRONMENT: 'local' },
    data: { requestId: 'new-order-reservation' },
    request: new Request('http://127.0.0.1:8788/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = 1').get() },
    { on_hand: 3, reserved: 2 },
  );
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT cart_id, inventory_mode, reservation_expires_at FROM orders').get() },
    { cart_id: CART_ID, inventory_mode: 'reservation', reservation_expires_at: null },
  );
  assert.equal(db.sqlite.prepare('SELECT sold_quantity FROM order_items').get().sold_quantity, 0);
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT movement_type, delta_on_hand, delta_reserved FROM inventory_movements').get() },
    { movement_type: 'reservation', delta_on_hand: 0, delta_reserved: 2 },
  );
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM cart_reservations').get().count, 0);
});

test('migration releases existing cart holds, disables new ones and preserves historical order mode', (t) => {
  const beforeMigration = [
    '0001_initial.sql', '0002_order_transitions.sql', '0003_admin_products.sql',
    '0007_catalog_cache.sql', '0017_cart_reservations.sql',
  ].map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')).join('\n');
  const db = setup(beforeMigration);
  t.after(() => db.close());
  db.sqlite.exec(`
    UPDATE inventory SET reserved = 2 WHERE product_id = 1;
    INSERT INTO orders (
      id, order_no, cart_id, status, language, customer_name, customer_phone,
      delivery_method, delivery_label, payment_method, payment_label,
      items_subtotal, total_amount
    ) VALUES (
      'old-order', 'NM-OLD', '${CART_ID}', 'pending', 'ro', 'Client', '+37368000000',
      'pickup', 'Pickup', 'cash', 'Cash', 100, 100
    );
    INSERT INTO cart_reservations (
      id, cart_id, product_id, quantity, status, expires_at
    ) VALUES (
      '22222222-2222-4222-8222-222222222222', '${CART_ID}', 1, 2, 'ACTIVE',
      '2099-01-01T00:00:00.000Z'
    );
  `);

  db.sqlite.exec(readFileSync(
    new URL('../migrations/0021_order_reservations_without_cart_timer.sql', import.meta.url),
    'utf8',
  ));

  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory WHERE product_id = 1').get().reserved, 0);
  assert.equal(db.sqlite.prepare('SELECT status FROM cart_reservations').get().status, 'CANCELLED');
  assert.equal(db.sqlite.prepare("SELECT inventory_mode FROM orders WHERE id = 'old-order'").get().inventory_mode, 'sold_at_creation');
  assert.throws(() => db.sqlite.prepare(`
    INSERT INTO cart_reservations (id, cart_id, product_id, quantity, status, expires_at)
    VALUES ('33333333-3333-4333-8333-333333333333', ?, 1, 1, 'ACTIVE', '2099-01-01T00:00:00.000Z')
  `).run('33333333-3333-4333-8333-333333333333'), /cart reservations are disabled/i);
});
