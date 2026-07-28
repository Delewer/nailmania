import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BudgetGuardD1, SqliteD1 } from './helpers/sqlite-d1.mjs';
import { createOrderReturn, OrderReturnError } from '../functions/_lib/order-returns.js';
import { onRequestPost as returnOrder } from '../functions/api/admin/orders/[id]/returns.js';
import { onRequestGet as listInventoryMovements } from '../functions/api/admin/inventory-movements/index.js';
import { onRequestGet as listAuditLog } from '../functions/api/admin/audit-log/index.js';

const schema = [
  readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0002_order_transitions.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0003_admin_products.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0006_returns_and_admin_journals.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0007_catalog_cache.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0009_promotions.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0010_statistics_and_analytics.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0011_notifications_and_order_operations.sql', import.meta.url), 'utf8'),
].join('\n');

function setup() {
  const db = new SqliteD1(schema);
  db.sqlite.prepare(`
    INSERT INTO categories (id, slug, name_ro, name_ru)
    VALUES ('test', 'test', 'Test', 'Test')
  `).run();
  for (const [id, email, role] of [
    ['admin-1', 'admin@example.test', 'admin'],
    ['manager-1', 'manager@example.test', 'manager'],
    ['customer-1', 'customer@example.test', 'customer'],
  ]) {
    db.sqlite.prepare(`
      INSERT INTO users (id, email, name, role, status)
      VALUES (?, ?, ?, ?, 'active')
    `).run(id, email, `${role} user`, role);
  }
  for (const id of [1, 2, 3]) {
    db.sqlite.prepare(`
      INSERT INTO products (id, catalog_key, sku, slug, category_id, name_ro, price)
      VALUES (?, ?, ?, ?, 'test', ?, 100)
    `).run(id, `SKU-${id}`, `SKU-${id}`, `sku-${id}`, `Product ${id}`);
    db.sqlite.prepare(`
      INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, admin_revision)
      VALUES (?, 1, ?, 0, ?)
    `).run(id, 10 - id, `initial:${id}`);
  }
  return db;
}

function insertCompletedOrder(db, id = 'order-1', productIds = [1, 2]) {
  db.sqlite.prepare(`
    INSERT INTO orders (
      id, order_no, status, language, customer_name, customer_phone,
      delivery_method, delivery_label, payment_method, payment_label,
      items_subtotal, catalog_discount, promo_discount, total_amount, completed_at
    ) VALUES (?, ?, 'completed', 'ro', 'Test Client', '+37360000000',
              'pickup', 'Pickup', 'cash', 'Cash', 500, 0, 0, 500, '2026-07-09T12:00:00.000Z')
  `).run(id, `NM-${id}`);
  return productIds.map((productId, index) => {
    const quantity = index === 0 ? 3 : 2;
    const result = db.sqlite.prepare(`
      INSERT INTO order_items (
        order_id, product_id, product_key, sku, name, unit_price, list_price,
        quantity, sold_quantity, returned_quantity, line_total
      ) VALUES (?, ?, ?, ?, ?, 100, 100, ?, ?, 0, ?)
    `).run(
      id, productId, `SKU-${productId}`, `SKU-${productId}`, `Product ${productId}`,
      quantity, quantity, quantity * 100,
    );
    return Number(result.lastInsertRowid);
  });
}

function insertProductsThrough(db, count) {
  for (let id = 4; id <= count; id += 1) {
    db.sqlite.prepare(`
      INSERT INTO products (id, catalog_key, sku, slug, category_id, name_ro, price)
      VALUES (?, ?, ?, ?, 'test', ?, 100)
    `).run(id, `SKU-${id}`, `SKU-${id}`, `sku-${id}`, `Product ${id}`);
    db.sqlite.prepare(`
      INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, admin_revision)
      VALUES (?, 1, 10, 0, ?)
    `).run(id, `initial:${id}`);
  }
}

const environment = (db, email) => ({
  DB: db,
  ENVIRONMENT: 'local',
  ADMIN_DEV_TOKEN: 'test-secret',
  ADMIN_DEV_EMAIL: email,
});

function context(db, path, options = {}) {
  const headers = new Headers({ authorization: 'Bearer test-secret' });
  if (options.method && options.method !== 'GET') headers.set('origin', 'http://127.0.0.1:8788');
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey);
  return {
    env: environment(db, options.email || 'manager@example.test'),
    params: options.params || {},
    request: new Request(`http://127.0.0.1:8788${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  };
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

test('a partial return is immutable and applied exactly once for an idempotency key', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const [itemId] = insertCompletedOrder(db);
  const request = {
    method: 'POST',
    params: { id: 'order-1' },
    idempotencyKey: 'return-request-0001',
    body: { reason: 'Client return', items: [{ orderItemId: itemId, quantity: 1 }] },
  };

  const first = await returnOrder(context(db, '/api/admin/orders/order-1/returns', request));
  const second = await returnOrder(context(db, '/api/admin/orders/order-1/returns', request));

  assert.equal(first.status, 201);
  assert.equal((await first.json()).created, true);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).created, false);
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT sold_quantity, returned_quantity FROM order_items WHERE id = ?').get(itemId) },
    { sold_quantity: 3, returned_quantity: 1 },
  );
  assert.equal(db.sqlite.prepare('SELECT on_hand FROM inventory WHERE product_id = 1').get().on_hand, 10);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_movements WHERE movement_type = 'return'").get().count, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_returns').get().count, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_return_items').get().count, 1);
  assert.equal(db.sqlite.prepare('SELECT revision FROM catalog_cache_state WHERE id = 1').get().revision, 2);
  assert.throws(
    () => db.sqlite.prepare("UPDATE order_returns SET reason = 'changed'").run(),
    /immutable/i,
  );

  const changedPayload = await returnOrder(context(db, '/api/admin/orders/order-1/returns', {
    ...request,
    body: { reason: 'Different reason', items: [{ orderItemId: itemId, quantity: 1 }] },
  }));
  assert.equal(changedPayload.status, 409);
  assert.equal((await changedPayload.json()).error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('a 50-line partial return stays within D1 query and binding budgets', async (t) => {
  const db = setup();
  t.after(() => db.close());
  insertProductsThrough(db, 50);
  const itemIds = insertCompletedOrder(db, 'order-budget', Array.from({ length: 50 }, (_, index) => index + 1));
  const guardedDb = new BudgetGuardD1(db);
  const result = await createOrderReturn(guardedDb, {
    orderId: 'order-budget',
    requestKey: 'return-budget-50-lines',
    actorUserId: 'manager-1',
    reason: 'Budget regression return',
    items: itemIds.map((orderItemId) => ({ orderItemId, quantity: 1 })),
    now: '2026-07-17T12:00:00.000Z',
  });
  assert.equal(result.created, true);
  assert.equal(result.return.items.length, 50);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_return_items').get().count, 50);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_movements WHERE movement_type = 'return'").get().count, 50);
  assert.ok(guardedDb.maxObservedBindings <= 100);
  assert.ok(guardedDb.maxBatchSize <= 50);
  assert.ok(guardedDb.queryCount <= 50);
});

test('return rejects over-return and an item owned by another order', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const [itemId] = insertCompletedOrder(db, 'order-1', [1]);
  const [foreignItemId] = insertCompletedOrder(db, 'order-2', [3]);

  const excessive = await returnOrder(context(db, '/api/admin/orders/order-1/returns', {
    method: 'POST', params: { id: 'order-1' }, idempotencyKey: 'return-request-0002',
    body: { reason: 'Too many', items: [{ orderItemId: itemId, quantity: 4 }] },
  }));
  assert.equal(excessive.status, 409);
  assert.equal((await excessive.json()).error.code, 'RETURN_QUANTITY_EXCEEDED');

  const foreign = await returnOrder(context(db, '/api/admin/orders/order-1/returns', {
    method: 'POST', params: { id: 'order-1' }, idempotencyKey: 'return-request-0003',
    body: { reason: 'Wrong order', items: [{ orderItemId: foreignItemId, quantity: 1 }] },
  }));
  assert.equal(foreign.status, 400);
  assert.equal((await foreign.json()).error.code, 'RETURN_ITEM_NOT_OWNED');
  assert.equal(db.sqlite.prepare('SELECT returned_quantity FROM order_items WHERE id = ?').get(itemId).returned_quantity, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_returns').get().count, 0);
});

test('a concurrent return revision prevents stale quantities from restoring stock twice', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const [itemId] = insertCompletedOrder(db, 'order-race', [1]);
  const racingDb = new BeforeFirstBatchD1(db, async () => {
    await createOrderReturn(db, {
      orderId: 'order-race', requestKey: 'race-return-inner', actorUserId: 'manager-1',
      reason: 'First return', items: [{ orderItemId: itemId, quantity: 1 }],
      now: '2026-07-16T10:00:00.000Z',
    });
  });

  await assert.rejects(
    createOrderReturn(racingDb, {
      orderId: 'order-race', requestKey: 'race-return-outer', actorUserId: 'manager-1',
      reason: 'Stale return', items: [{ orderItemId: itemId, quantity: 2 }],
      now: '2026-07-16T10:01:00.000Z',
    }),
    (error) => error instanceof OrderReturnError && error.code === 'ORDER_RETURN_CONFLICT',
  );
  assert.equal(db.sqlite.prepare('SELECT returned_quantity FROM order_items WHERE id = ?').get(itemId).returned_quantity, 1);
  assert.equal(db.sqlite.prepare('SELECT on_hand FROM inventory WHERE product_id = 1').get().on_hand, 10);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_returns').get().count, 1);
});

test('manager can operate returns and inventory journal, while audit log is admin-only', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const [itemId] = insertCompletedOrder(db, 'order-roles', [1]);
  const managerReturn = await returnOrder(context(db, '/api/admin/orders/order-roles/returns', {
    method: 'POST', params: { id: 'order-roles' }, idempotencyKey: 'role-return-manager',
    body: { reason: 'Manager return', items: [{ orderItemId: itemId, quantity: 1 }] },
  }));
  assert.equal(managerReturn.status, 201);

  const customerReturn = await returnOrder(context(db, '/api/admin/orders/order-roles/returns', {
    email: 'customer@example.test', method: 'POST', params: { id: 'order-roles' },
    idempotencyKey: 'role-return-customer',
    body: { reason: 'Customer attempt', items: [{ orderItemId: itemId, quantity: 1 }] },
  }));
  assert.equal(customerReturn.status, 403);

  const managerJournal = await listInventoryMovements(context(db, '/api/admin/inventory-movements?type=return'));
  assert.equal(managerJournal.status, 200);
  assert.equal((await managerJournal.json()).items.length, 1);

  const managerAudit = await listAuditLog(context(db, '/api/admin/audit-log'));
  assert.equal(managerAudit.status, 403);
  const adminAudit = await listAuditLog(context(db, '/api/admin/audit-log?action=order.return.create', {
    email: 'admin@example.test',
  }));
  assert.equal(adminAudit.status, 200);
  const auditPayload = await adminAudit.json();
  assert.equal(auditPayload.items.length, 1);
  assert.equal(auditPayload.items[0].entityId, 'order-roles');
});

test('inventory journal supports product, order, type, date filters and pagination', async (t) => {
  const db = setup();
  t.after(() => db.close());
  insertCompletedOrder(db, 'order-journal', [1]);
  const insertMovement = db.sqlite.prepare(`
    INSERT INTO inventory_movements (
      id, product_id, warehouse_id, movement_type, delta_on_hand, delta_reserved,
      balance_on_hand, balance_reserved, order_id, actor_user_id, reason, created_at
    ) VALUES (?, ?, 1, ?, ?, 0, ?, 0, ?, 'manager-1', ?, ?)
  `);
  insertMovement.run('journal-1', 1, 'receipt', 2, 11, 'order-journal', 'Supplier A', '2026-07-10T10:00:00.000Z');
  insertMovement.run('journal-2', 2, 'receipt', 3, 11, null, 'Supplier B', '2026-07-11T10:00:00.000Z');
  insertMovement.run('journal-3', 2, 'write_off', -1, 10, null, 'Damaged', '2026-07-12T10:00:00.000Z');

  const filtered = await listInventoryMovements(context(
    db,
    '/api/admin/inventory-movements?type=receipt&product=SKU-1&order=NM-order-journal&from=2026-07-10&to=2026-07-10',
  ));
  const filteredPayload = await filtered.json();
  assert.equal(filtered.status, 200);
  assert.equal(filteredPayload.pagination.total, 1);
  assert.equal(filteredPayload.items[0].id, 'journal-1');

  const paginated = await listInventoryMovements(context(db, '/api/admin/inventory-movements?type=receipt&limit=1&offset=1'));
  const pagePayload = await paginated.json();
  assert.equal(pagePayload.pagination.total, 2);
  assert.equal(pagePayload.items.length, 1);
  assert.equal(pagePayload.items[0].id, 'journal-1');
});
