import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';
import {
  OrderLifecycleError,
  releaseExpiredReservations,
  transitionOrder,
  transitionPlan,
} from '../functions/_lib/order-lifecycle.js';

const schema = [
  readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0002_order_transitions.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0003_admin_products.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0006_returns_and_admin_journals.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0007_catalog_cache.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0009_promotions.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0015_cancelled_order_reopening.sql', import.meta.url), 'utf8'),
].join('\n');

function setup() {
  const db = new SqliteD1(schema);
  db.sqlite.prepare(`
    INSERT INTO categories (id, slug, name_ro, name_ru)
    VALUES ('test', 'test', 'Test', 'Test')
  `).run();
  return db;
}

class BeforeFirstBatchD1 {
  constructor(db, beforeBatch) {
    this.db = db;
    this.beforeBatch = beforeBatch;
  }

  prepare(sql) { return this.db.prepare(sql); }
  withSession() { return this; }
  async batch(statements) {
    const beforeBatch = this.beforeBatch;
    this.beforeBatch = null;
    if (beforeBatch) await beforeBatch();
    return this.db.batch(statements);
  }
}

function insertReservedOrder(db, options = {}) {
  const id = options.id || 'order-1';
  const productId = options.productId || 1;
  const quantity = options.quantity || 2;
  const onHand = options.onHand || 5;
  const status = options.status || 'pending';
  const expiresAt = options.expiresAt ?? '2026-07-15T00:00:00.000Z';
  const inventoryRevision = options.inventoryRevision || `inventory:${id}:initial`;
  db.sqlite.prepare(`
    INSERT INTO products (id, catalog_key, sku, slug, category_id, name_ro, price)
    VALUES (?, ?, ?, ?, 'test', ?, 100)
  `).run(productId, `P${productId}`, `P${productId}`, `p-${productId}`, `Product ${productId}`);
  db.sqlite.prepare(`
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, admin_revision)
    VALUES (?, 1, ?, ?, ?)
  `).run(productId, onHand, quantity, inventoryRevision);
  db.sqlite.prepare(`
    INSERT INTO orders (
      id, order_no, status, language, customer_name, customer_phone,
      delivery_method, delivery_label, payment_method, payment_label,
      items_subtotal, catalog_discount, promo_discount, total_amount, reservation_expires_at
    ) VALUES (?, ?, ?, 'ro', 'Test Client', '+37360000000',
              'pickup', 'Pickup', 'cash', 'Cash', ?, 0, 0, ?, ?)
  `).run(id, `NM-${id}`, status, quantity * 100, quantity * 100, expiresAt);
  db.sqlite.prepare(`
    INSERT INTO order_items (
      order_id, product_id, product_key, sku, name,
      unit_price, list_price, quantity, line_total
    ) VALUES (?, ?, ?, ?, ?, 100, 100, ?, ?)
  `).run(id, productId, `P${productId}`, `P${productId}`, `Product ${productId}`, quantity, quantity * 100);
  db.sqlite.prepare(`
    INSERT INTO inventory_movements (
      id, product_id, warehouse_id, movement_type, delta_reserved,
      balance_on_hand, balance_reserved, order_id, reason
    ) VALUES (?, ?, 1, 'reservation', ?, ?, ?, ?, 'Test reservation')
  `).run(`reserve:${id}:${productId}`, productId, quantity, onHand, quantity, id);
  return { id, productId, quantity, onHand, inventoryRevision };
}

test('maps allowed status transitions to inventory actions', () => {
  assert.deepEqual(transitionPlan('pending', 'confirmed'), { action: 'none', idempotent: false });
  assert.deepEqual(transitionPlan('cancelled', 'confirmed'), { action: 'reserve', idempotent: false });
  assert.deepEqual(transitionPlan('ready', 'completed'), { action: 'sale', idempotent: false });
  assert.deepEqual(transitionPlan('completed', 'returned'), { action: 'return', idempotent: false });
  assert.throws(
    () => transitionPlan('pending', 'completed'),
    (error) => error instanceof OrderLifecycleError && error.code === 'INVALID_STATUS_TRANSITION',
  );
});

test('cancellation releases a reservation exactly once', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const order = insertReservedOrder(db);

  const first = await transitionOrder(db, {
    orderId: order.id,
    toStatus: 'cancelled',
    comment: 'Customer cancelled',
    now: '2026-07-16T10:00:00.000Z',
  });
  const second = await transitionOrder(db, {
    orderId: order.id,
    toStatus: 'cancelled',
    now: '2026-07-16T10:01:00.000Z',
  });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = ?').get(order.productId) },
    { on_hand: 5, reserved: 0 },
  );
  assert.deepEqual(
    { ...db.sqlite.prepare(`
      SELECT movement_type, delta_on_hand, delta_reserved, balance_on_hand, balance_reserved
      FROM inventory_movements WHERE id = ?
    `).get(`release:${first.transitionToken}:${order.productId}`) },
    { movement_type: 'reservation_release', delta_on_hand: 0, delta_reserved: -2, balance_on_hand: 5, balance_reserved: 0 },
  );
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_movements WHERE movement_type = 'reservation_release'").get().count, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM admin_audit_log').get().count, 1);
  assert.equal(
    db.sqlite.prepare('SELECT admin_revision FROM inventory WHERE product_id = ?').get(order.productId).admin_revision,
    `order:${first.transitionToken}:release`,
  );
});

test('a cancelled order reopens as confirmed and repeated cycles preserve exact stock journals', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const order = insertReservedOrder(db);

  const firstCancellation = await transitionOrder(db, {
    orderId: order.id,
    toStatus: 'cancelled',
    comment: 'Cancelled once',
    now: '2026-07-16T10:00:00.000Z',
  });
  const firstReopen = await transitionOrder(db, {
    orderId: order.id,
    toStatus: 'confirmed',
    comment: 'Reopened once',
    now: '2026-07-16T11:00:00.000Z',
  });
  const secondCancellation = await transitionOrder(db, {
    orderId: order.id,
    toStatus: 'cancelled',
    comment: 'Cancelled twice',
    now: '2026-07-16T12:00:00.000Z',
  });
  const secondReopen = await transitionOrder(db, {
    orderId: order.id,
    toStatus: 'confirmed',
    comment: 'Reopened twice',
    now: '2026-07-16T13:00:00.000Z',
  });

  assert.equal(firstReopen.action, 'reserve');
  assert.equal(secondReopen.action, 'reserve');
  assert.deepEqual(
    { ...db.sqlite.prepare(`
      SELECT status, reservation_expires_at, confirmed_at, cancelled_at
      FROM orders WHERE id = ?
    `).get(order.id) },
    {
      status: 'confirmed',
      reservation_expires_at: null,
      confirmed_at: '2026-07-16T13:00:00.000Z',
      cancelled_at: null,
    },
  );
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = ?').get(order.productId) },
    { on_hand: 5, reserved: 2 },
  );
  assert.deepEqual(
    db.sqlite.prepare(`
      SELECT id, movement_type, delta_reserved
      FROM inventory_movements
      WHERE order_id = ? AND movement_type IN ('reservation', 'reservation_release')
      ORDER BY id
    `).all(order.id).map((row) => ({ ...row })),
    [
      { id: `release:${firstCancellation.transitionToken}:${order.productId}`, movement_type: 'reservation_release', delta_reserved: -2 },
      { id: `release:${secondCancellation.transitionToken}:${order.productId}`, movement_type: 'reservation_release', delta_reserved: -2 },
      { id: `reserve:${firstReopen.transitionToken}:${order.productId}`, movement_type: 'reservation', delta_reserved: 2 },
      { id: `reserve:${order.id}:${order.productId}`, movement_type: 'reservation', delta_reserved: 2 },
      { id: `reserve:${secondReopen.transitionToken}:${order.productId}`, movement_type: 'reservation', delta_reserved: 2 },
    ].sort((left, right) => left.id.localeCompare(right.id)),
  );
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_status_history WHERE order_id = ?').get(order.id).count, 4);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM admin_audit_log WHERE entity_id = ?').get(order.id).count, 4);
  assert.equal(
    db.sqlite.prepare('SELECT admin_revision FROM inventory WHERE product_id = ?').get(order.productId).admin_revision,
    `order:${secondReopen.transitionToken}:reserve`,
  );
});

test('reopening a cancelled order fails atomically when stock is no longer available', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const order = insertReservedOrder(db, { onHand: 2 });

  await transitionOrder(db, {
    orderId: order.id,
    toStatus: 'cancelled',
    now: '2026-07-16T10:00:00.000Z',
  });
  db.sqlite.prepare('UPDATE inventory SET reserved = on_hand WHERE product_id = ?').run(order.productId);
  const revisionBefore = db.sqlite.prepare('SELECT revision FROM catalog_cache_state WHERE id = 1').get().revision;

  await assert.rejects(
    transitionOrder(db, {
      orderId: order.id,
      toStatus: 'confirmed',
      now: '2026-07-16T11:00:00.000Z',
    }),
    (error) => error instanceof OrderLifecycleError
      && error.code === 'ORDER_REOPEN_INVENTORY_UNAVAILABLE'
      && error.status === 409,
  );

  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT status, confirmed_at, cancelled_at FROM orders WHERE id = ?').get(order.id) },
    { status: 'cancelled', confirmed_at: null, cancelled_at: '2026-07-16T10:00:00.000Z' },
  );
  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory WHERE product_id = ?').get(order.productId).reserved, 2);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_status_history WHERE order_id = ?').get(order.id).count, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM admin_audit_log WHERE entity_id = ?').get(order.id).count, 1);
  assert.equal(db.sqlite.prepare('SELECT revision FROM catalog_cache_state WHERE id = 1').get().revision, revisionBefore);
});

test('reopening a cancelled order fails safely when an inventory row is missing', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const order = insertReservedOrder(db);
  await transitionOrder(db, { orderId: order.id, toStatus: 'cancelled' });
  db.sqlite.prepare('DELETE FROM inventory WHERE product_id = ?').run(order.productId);

  await assert.rejects(
    transitionOrder(db, { orderId: order.id, toStatus: 'confirmed' }),
    (error) => error instanceof OrderLifecycleError && error.code === 'ORDER_REOPEN_INVENTORY_UNAVAILABLE',
  );
  assert.equal(db.sqlite.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'cancelled');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_status_history WHERE order_id = ?').get(order.id).count, 1);
});

test('concurrent duplicate reopen reserves stock only once', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const order = insertReservedOrder(db);
  await transitionOrder(db, { orderId: order.id, toStatus: 'cancelled' });

  let winningTransition;
  const racingDb = new BeforeFirstBatchD1(db, async () => {
    winningTransition = await transitionOrder(db, {
      orderId: order.id,
      toStatus: 'confirmed',
      now: '2026-07-16T11:00:00.000Z',
    });
  });
  const losingTransition = await transitionOrder(racingDb, {
    orderId: order.id,
    toStatus: 'confirmed',
    now: '2026-07-16T11:00:01.000Z',
  });

  assert.equal(winningTransition.changed, true);
  assert.equal(losingTransition.changed, false);
  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory WHERE product_id = ?').get(order.productId).reserved, 2);
  assert.equal(
    db.sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_movements WHERE movement_type = 'reservation'").get().count,
    2,
  );
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_status_history WHERE order_id = ?').get(order.id).count, 2);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM admin_audit_log WHERE entity_id = ?').get(order.id).count, 2);
});

test('confirmation keeps stock reserved and disables automatic expiry', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const order = insertReservedOrder(db);

  await transitionOrder(db, {
    orderId: order.id,
    toStatus: 'confirmed',
    now: '2026-07-16T10:00:00.000Z',
  });

  assert.deepEqual(
    { ...db.sqlite.prepare(`
      SELECT status, reservation_expires_at, confirmed_at
      FROM orders WHERE id = ?
    `).get(order.id) },
    { status: 'confirmed', reservation_expires_at: null, confirmed_at: '2026-07-16T10:00:00.000Z' },
  );
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = ?').get(order.productId) },
    { on_hand: 5, reserved: 2 },
  );
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM inventory_movements').get().count, 1);
});

test('an inventory mismatch rolls back the complete transition', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const order = insertReservedOrder(db);
  db.sqlite.prepare('UPDATE inventory SET reserved = 0 WHERE product_id = ?').run(order.productId);

  await assert.rejects(
    transitionOrder(db, {
      orderId: order.id,
      toStatus: 'cancelled',
      now: '2026-07-16T10:00:00.000Z',
    }),
    (error) => error instanceof OrderLifecycleError && error.code === 'INVENTORY_STATE_CONFLICT',
  );

  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT status, transition_token FROM orders WHERE id = ?').get(order.id) },
    { status: 'pending', transition_token: null },
  );
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_movements WHERE movement_type = 'reservation_release'").get().count, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM admin_audit_log').get().count, 0);
});

test('completion sells reserved stock and a full return restores it', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const order = insertReservedOrder(db, { status: 'ready' });

  const sale = await transitionOrder(db, {
    orderId: order.id,
    toStatus: 'completed',
    now: '2026-07-16T10:00:00.000Z',
  });
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = ?').get(order.productId) },
    { on_hand: 3, reserved: 0 },
  );
  assert.deepEqual(
    { ...db.sqlite.prepare("SELECT delta_on_hand, delta_reserved FROM inventory_movements WHERE movement_type = 'sale'").get() },
    { delta_on_hand: -2, delta_reserved: -2 },
  );
  assert.equal(
    db.sqlite.prepare('SELECT admin_revision FROM inventory WHERE product_id = ?').get(order.productId).admin_revision,
    `order:${sale.transitionToken}:sale`,
  );

  const returned = await transitionOrder(db, {
    orderId: order.id,
    toStatus: 'returned',
    now: '2026-07-16T11:00:00.000Z',
  });
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = ?').get(order.productId) },
    { on_hand: 5, reserved: 0 },
  );
  assert.equal(db.sqlite.prepare('SELECT returned_quantity FROM order_items WHERE order_id = ?').get(order.id).returned_quantity, 2);
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT sold_quantity, returned_quantity FROM order_items WHERE order_id = ?').get(order.id) },
    { sold_quantity: 2, returned_quantity: 2 },
  );
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_returns WHERE order_id = ?').get(order.id).count, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_return_items').get().count, 1);
  assert.deepEqual(
    { ...db.sqlite.prepare("SELECT delta_on_hand, delta_reserved FROM inventory_movements WHERE movement_type = 'return'").get() },
    { delta_on_hand: 2, delta_reserved: 0 },
  );
  assert.equal(
    db.sqlite.prepare('SELECT admin_revision FROM inventory WHERE product_id = ?').get(order.productId).admin_revision,
    `order:${returned.transitionToken}:return`,
  );
});

test('expired cleanup cancels only expired pending orders', async (t) => {
  const db = setup();
  t.after(() => db.close());
  insertReservedOrder(db, { id: 'expired', productId: 1, quantity: 1, expiresAt: '2026-07-15T00:00:00.000Z' });
  insertReservedOrder(db, { id: 'future', productId: 2, quantity: 1, expiresAt: '2026-07-18T00:00:00.000Z' });
  insertReservedOrder(db, { id: 'confirmed', productId: 3, quantity: 1, status: 'confirmed', expiresAt: '2026-07-15T00:00:00.000Z' });

  const result = await releaseExpiredReservations(db, {
    now: '2026-07-16T10:00:00.000Z',
    limit: 10,
  });

  assert.deepEqual(result, {
    checkedAt: '2026-07-16T10:00:00.000Z',
    selected: 1,
    released: 1,
    skipped: 0,
    errors: [],
  });
  assert.equal(db.sqlite.prepare("SELECT status FROM orders WHERE id = 'expired'").get().status, 'cancelled');
  assert.equal(db.sqlite.prepare("SELECT status FROM orders WHERE id = 'future'").get().status, 'pending');
  assert.equal(db.sqlite.prepare("SELECT status FROM orders WHERE id = 'confirmed'").get().status, 'confirmed');
  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory WHERE product_id = 1').get().reserved, 0);
  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory WHERE product_id = 2').get().reserved, 1);
  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory WHERE product_id = 3').get().reserved, 1);
});
