import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listActiveCartReservations,
  releaseExpiredCartReservations,
  releaseExpiredCartReservationsForProduct,
  synchronizeCartReservation,
} from '../functions/_lib/cart-reservations.js';
import { transitionOrder } from '../functions/_lib/order-lifecycle.js';
import { stockAdjustmentPlan } from '../functions/_lib/admin-products.js';
import { onRequestPost as createOrder } from '../functions/api/orders.js';
import {
  onRequestDelete as deleteReservation,
  onRequestPatch as patchReservation,
} from '../functions/api/reservations/[id].js';
import { fullSchema } from './helpers/full-schema.mjs';
import { withOrderContract } from './helpers/order-fixture.mjs';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';

const CART_A = '11111111-1111-4111-8111-111111111111';
const CART_B = '22222222-2222-4222-8222-222222222222';

function setup(onHand = 1) {
  const db = new SqliteD1(fullSchema);
  db.sqlite.exec(`
    INSERT INTO categories (id, slug, name_ro, name_ru)
    VALUES ('test', 'test', 'Test', 'Test');
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, brand, name_ro, name_ru, price, old_price
    ) VALUES (1, 'P1', 'P1', 'p1', 'test', 'Brand', 'Produs', 'Product', 100, 0);
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved)
    VALUES (1, 1, ${onHand}, 0);
  `);
  return db;
}

const reserve = (db, cartId, quantity, now = '2026-08-25T10:00:00.000Z') => (
  synchronizeCartReservation(db, { cartId, productKey: 'P1', quantity }, {
    env: { RESERVATION_TTL_MINUTES: '60' },
    now,
  })
);

test('a numeric catalog key is not confused with an internal product id', async (t) => {
  const db = setup(1);
  t.after(() => db.close());
  db.sqlite.exec(`
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, brand, name_ro, name_ru, price, old_price
    ) VALUES
      (2, 'OTHER', 'OTHER', 'other', 'test', 'Brand', 'Alt produs', 'Other product', 50, 0),
      (10, '2', '2', 'numeric-key', 'test', 'Valeri', 'Valeri Builder Gel', 'Valeri Builder Gel', 145, 0);
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved)
    VALUES (2, 1, 5, 0), (10, 1, 3, 0);
  `);

  const reservation = await synchronizeCartReservation(db, {
    cartId: CART_A,
    productKey: '2',
    quantity: 1,
  }, { env: { RESERVATION_TTL_MINUTES: '60' } });

  assert.equal(reservation.productId, 10);
  assert.equal(reservation.productKey, '2');
  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory WHERE product_id = 2').get().reserved, 0);
  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory WHERE product_id = 10').get().reserved, 1);
});

function reservationContext(db, id, method, body) {
  return {
    env: { DB: db, ENVIRONMENT: 'local', RESERVATION_TTL_MINUTES: '60' },
    params: { id },
    request: new Request(`https://example.test/api/reservations/${id}`, {
      method,
      headers: { origin: 'https://example.test', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

test('adding the last unit to a cart immediately blocks another cart and a physical sale', async (t) => {
  const db = setup(1);
  t.after(() => db.close());

  const outcomes = await Promise.allSettled([
    reserve(db, CART_A, 1),
    reserve(db, CART_B, 1),
  ]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status === 'fulfilled' ? 'reserved' : outcome.reason.code).sort(),
    ['INSUFFICIENT_STOCK', 'reserved'],
  );
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = 1').get() },
    { on_hand: 1, reserved: 1 },
  );
  assert.throws(
    () => stockAdjustmentPlan(
      { operation: 'write_off', quantity: 1, reason: 'Physical shop sale' },
      { onHand: 1, reserved: 1 },
    ),
    (error) => error.code === 'INSUFFICIENT_UNRESERVED_STOCK',
  );
});

test('the first 60 minute deadline is not extended and expiry releases stock without the worker', async (t) => {
  const db = setup(2);
  t.after(() => db.close());

  const first = await reserve(db, CART_A, 1);
  const changed = await reserve(db, CART_A, 2, '2026-08-25T10:10:00.000Z');
  assert.equal(first.expiresAt, '2026-08-25T11:00:00.000Z');
  assert.equal(changed.expiresAt, first.expiresAt);
  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory').get().reserved, 2);

  const active = await listActiveCartReservations(db, CART_A, {
    now: '2026-08-25T11:00:00.001Z',
  });
  assert.deepEqual(active, []);
  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory').get().reserved, 0);
  assert.equal(db.sqlite.prepare('SELECT status FROM cart_reservations').get().status, 'EXPIRED');
});

test('a physical stock operation can release every expired hold for one product in one batch', async (t) => {
  const db = setup(300);
  t.after(() => db.close());
  const insert = db.sqlite.prepare(`
    INSERT INTO cart_reservations (
      id, cart_id, product_id, quantity, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, 1, 1, 'ACTIVE', '2026-01-01T00:15:00.000Z',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `);
  for (let index = 1; index <= 300; index += 1) {
    const suffix = String(index).padStart(12, '0');
    const id = `00000000-0000-4000-8000-${suffix}`;
    insert.run(id, id);
  }
  db.sqlite.prepare('UPDATE inventory SET reserved = 300 WHERE product_id = 1').run();

  const result = await releaseExpiredCartReservationsForProduct(db, 1, {
    now: '2026-08-25T10:00:00.000Z',
  });
  assert.equal(result.released, 300);
  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory WHERE product_id = 1').get().reserved, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM cart_reservations WHERE status = 'EXPIRED'").get().count, 300);
});

test('quantity changes and removal update the same reservation and release availability immediately', async (t) => {
  const db = setup(3);
  t.after(() => db.close());
  const created = await synchronizeCartReservation(db, {
    cartId: CART_A,
    productKey: 'P1',
    quantity: 1,
  }, { env: { RESERVATION_TTL_MINUTES: '60' } });

  const increased = await patchReservation(reservationContext(db, created.id, 'PATCH', {
    cartId: CART_A,
    quantity: 2,
  }));
  assert.equal(increased.status, 200);
  assert.equal((await increased.json()).reservation.quantity, 2);
  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory').get().reserved, 2);

  const decreased = await patchReservation(reservationContext(db, created.id, 'PATCH', {
    cartId: CART_A,
    quantity: 1,
  }));
  assert.equal(decreased.status, 200);
  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory').get().reserved, 1);

  const removed = await deleteReservation(reservationContext(db, created.id, 'DELETE', {
    cartId: CART_A,
  }));
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).reservation.status, 'CANCELLED');
  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory').get().reserved, 0);
  assert.equal(db.sqlite.prepare('SELECT status FROM cart_reservations').get().status, 'CANCELLED');
});

test('exactly one of 50 carts can reserve the final unit', async (t) => {
  const db = setup(1);
  t.after(() => db.close());
  const attempts = Array.from({ length: 50 }, (_, index) => {
    const suffix = String(index + 1).padStart(12, '0');
    return reserve(db, `00000000-0000-4000-8000-${suffix}`, 1);
  });
  const outcomes = await Promise.allSettled(attempts);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.reason?.code === 'INSUFFICIENT_STOCK').length, 49);
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory').get() },
    { on_hand: 1, reserved: 1 },
  );
});

test('placing an order converts the cart reservation into one sale without online payment', async (t) => {
  const db = setup(1);
  t.after(() => db.close());
  await synchronizeCartReservation(db, {
    cartId: CART_A,
    productKey: 'P1',
    quantity: 1,
  }, { env: { RESERVATION_TTL_MINUTES: '60' } });

  const body = withOrderContract(db, {
    cartId: CART_A,
    items: [{ productKey: 'P1', quantity: 1 }],
    customer: { name: 'Ana Test', phone: '+37368000000' },
    delivery: 'pickup',
    payment: 'cash',
    lang: 'ro',
  });
  const response = await createOrder({
    env: { DB: db, ENVIRONMENT: 'local' },
    request: new Request('https://example.test/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory').get() },
    { on_hand: 0, reserved: 0 },
  );
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT status, order_id FROM cart_reservations').get() },
    { status: 'CONVERTED', order_id: payload.order.id },
  );
  assert.equal(db.sqlite.prepare('SELECT sold_quantity FROM order_items').get().sold_quantity, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_movements WHERE movement_type = 'sale'").get().count, 1);

  for (const status of ['confirmed', 'processing', 'ready', 'completed']) {
    await transitionOrder(db, { orderId: payload.order.id, toStatus: status });
  }
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory').get() },
    { on_hand: 0, reserved: 0 },
  );
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_movements WHERE movement_type = 'sale'").get().count, 1);
});

test('an expired reservation cannot be converted into an order', async (t) => {
  const db = setup(1);
  t.after(() => db.close());
  await reserve(db, CART_A, 1, '2026-01-01T10:00:00.000Z');
  const body = withOrderContract(db, {
    cartId: CART_A,
    items: [{ productKey: 'P1', quantity: 1 }],
    customer: { name: 'Ana Test', phone: '+37368000000' },
    delivery: 'pickup',
    payment: 'cash',
    lang: 'ro',
  });
  const response = await createOrder({
    env: { DB: db, ENVIRONMENT: 'local' },
    request: new Request('https://example.test/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'ACTIVE_RESERVATION_REQUIRED');

  await releaseExpiredCartReservations(db);
  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory').get().reserved, 0);
});

test('non-local order submission cannot bypass the cart reservation flow', async (t) => {
  const db = setup(1);
  t.after(() => db.close());
  const body = withOrderContract(db, {
    items: [{ productKey: 'P1', quantity: 1 }],
    customer: { name: 'Ana Test', phone: '+37368000000' },
    delivery: 'pickup',
    payment: 'cash',
    lang: 'ro',
  });
  const response = await createOrder({
    env: {
      DB: db,
      ENVIRONMENT: 'production',
      AUTH_FINGERPRINT_SALT: 'production-order-fingerprint-test-secret',
    },
    request: new Request('https://example.test/api/orders', {
      method: 'POST',
      headers: { origin: 'https://example.test', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'ACTIVE_RESERVATION_REQUIRED');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 0);
});
