import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BudgetGuardD1, SqliteD1 } from './helpers/sqlite-d1.mjs';
import {
  allocatePromoDiscount,
  calculatePromoDiscount,
  cumulativePromoRefund,
  PromoValidationError,
  validatePromotion,
} from '../functions/_lib/promos.js';
import { onRequestPost as validatePromoEndpoint } from '../functions/api/promos/validate.js';
import { onRequestPost as createOrder } from '../functions/api/orders.js';
import { transitionOrder } from '../functions/_lib/order-lifecycle.js';
import { createOrderReturn } from '../functions/_lib/order-returns.js';
import { getAdminOrder } from '../functions/_lib/admin-orders.js';
import { onRequestGet as listAdminOrders } from '../functions/api/admin/orders/index.js';
import { newSessionRecord } from '../functions/_lib/customer-auth.js';
import { withOrderContract } from './helpers/order-fixture.mjs';
import {
  onRequestGet as listPromos,
  onRequestPost as createPromo,
} from '../functions/api/admin/promos/index.js';
import {
  onRequestGet as getPromo,
  onRequestPatch as updatePromo,
  onRequestDelete as deactivatePromo,
} from '../functions/api/admin/promos/[id].js';

const migrationNames = [
  '0001_initial.sql',
  '0002_order_transitions.sql',
  '0003_admin_products.sql',
  '0004_admin_categories.sql',
  '0005_customer_accounts.sql',
  '0006_returns_and_admin_journals.sql',
  '0007_catalog_cache.sql',
  '0008_rate_limits.sql',
  '0009_promotions.sql',
  '0010_statistics_and_analytics.sql',
  '0011_notifications_and_order_operations.sql',
  '0012_order_idempotency.sql',
  '0013_order_commercial_snapshot_guard.sql',
];
const schema = migrationNames.map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')).join('\n');

function setup() {
  const db = new SqliteD1(schema);
  db.sqlite.exec(`
    INSERT INTO categories (id, slug, name_ro, name_ru)
    VALUES ('cat-a', 'cat-a', 'Categoria A', 'Категория A'),
           ('cat-b', 'cat-b', 'Categoria B', 'Категория B');
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, brand, name_ro, name_ru,
      price, old_price, cost_price, admin_revision
    ) VALUES
      (1, 'PROMO-A', 'PROMO-A', 'promo-a', 'cat-a', 'Brand A', 'Produs A', 'Товар A', 101, 121, 50, 'p:1'),
      (2, 'PROMO-B', 'PROMO-B', 'promo-b', 'cat-b', 'Brand B', 'Produs B', 'Товар B', 199, 219, 80, 'p:2'),
      (3, 'PROMO-2200', 'PROMO-2200', 'promo-2200', 'cat-a', 'Brand A', 'Prag livrare', 'Порог доставки', 1100, 1100, 600, 'p:3');
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, admin_revision)
    VALUES (1, 1, 20, 0, 'i:1'), (2, 1, 20, 0, 'i:2'), (3, 1, 20, 0, 'i:3');
    INSERT INTO users (id, email, name, role, status)
    VALUES ('admin-1', 'admin@example.test', 'Promo Admin', 'admin', 'active'),
           ('customer-1', 'customer@example.test', 'Promo Customer', 'customer', 'active');
  `);
  return db;
}

function insertMaximumScopes(db, count = 100) {
  const categoryIds = [];
  const productIds = [];
  for (let index = 1; index <= count; index += 1) {
    const categoryId = `scope-cat-${String(index).padStart(3, '0')}`;
    const productId = 1000 + index;
    categoryIds.push(categoryId);
    productIds.push(productId);
    db.sqlite.prepare(`
      INSERT INTO categories (id, slug, name_ro, name_ru)
      VALUES (?, ?, ?, ?)
    `).run(categoryId, categoryId, `Scope ${index}`, `Scope ${index}`);
    db.sqlite.prepare(`
      INSERT INTO products (
        id, catalog_key, sku, slug, category_id, name_ro, price, admin_revision
      ) VALUES (?, ?, ?, ?, ?, ?, 100, ?)
    `).run(
      productId, `SCOPE-${index}`, `SCOPE-${index}`, `scope-${index}`,
      categoryId, `Scope product ${index}`, `scope:${index}`,
    );
  }
  return { categoryIds, productIds };
}

function insertPromo(db, overrides = {}) {
  const promo = {
    id: `promo-${crypto.randomUUID()}`,
    code: 'PROMO10',
    discountType: 'percent',
    discountValue: 10,
    maxDiscount: null,
    minOrderAmount: 0,
    startsAt: '2020-01-01T00:00:00.000Z',
    endsAt: '2099-01-01T00:00:00.000Z',
    totalUseLimit: null,
    perUserLimit: null,
    isActive: 1,
    ...overrides,
  };
  db.sqlite.prepare(`
    INSERT INTO promo_codes (
      id, code, discount_type, discount_value, max_discount, min_order_amount,
      starts_at, ends_at, total_use_limit, per_user_limit, is_active, admin_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    promo.id, promo.code, promo.discountType, promo.discountValue, promo.maxDiscount,
    promo.minOrderAmount, promo.startsAt, promo.endsAt, promo.totalUseLimit,
    promo.perUserLimit, promo.isActive, `revision:${promo.id}`,
  );
  return promo;
}

const baseEnv = (db) => ({ DB: db, ENVIRONMENT: 'local' });
const orderBody = (overrides = {}) => ({
  items: [{ productKey: 'PROMO-A', quantity: 1 }],
  customer: { name: 'Ana Promo', phone: '+37368000000' },
  delivery: 'pickup',
  payment: 'cash',
  lang: 'ro',
  ...overrides,
});
function orderContext(db, body, extra = {}) {
  const contracted = withOrderContract(db, body);
  const headers = new Headers({ 'content-type': 'application/json' });
  if (extra.cookie) {
    headers.set('cookie', extra.cookie);
    headers.set('origin', 'http://127.0.0.1:8788');
  }
  return {
    env: baseEnv(db),
    data: { requestId: crypto.randomUUID() },
    request: new Request('http://127.0.0.1:8788/api/orders', {
      method: 'POST',
      headers,
      body: JSON.stringify(contracted),
    }),
    waitUntil: extra.waitUntil,
  };
}

async function customerCookie(db) {
  const request = new Request('http://127.0.0.1:8788/login', { headers: { 'user-agent': 'promo-test' } });
  const session = await newSessionRecord(db, 'customer-1', request, baseEnv(db));
  await session.statement.run();
  return `nm_session=${session.token}`;
}
function promoValidationContext(db, body) {
  return {
    env: baseEnv(db),
    request: new Request('http://127.0.0.1:8788/api/promos/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}
function adminContext(db, path, { method = 'GET', body, params = {} } = {}) {
  const headers = new Headers({ authorization: 'Bearer promo-admin-token' });
  if (method !== 'GET') headers.set('origin', 'http://127.0.0.1:8788');
  if (body !== undefined) headers.set('content-type', 'application/json');
  return {
    env: {
      DB: db,
      ENVIRONMENT: 'local',
      ADMIN_DEV_TOKEN: 'promo-admin-token',
      ADMIN_DEV_EMAIL: 'admin@example.test',
    },
    params,
    request: new Request(`http://127.0.0.1:8788${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  };
}

class BeforeFirstBatchD1 {
  constructor(db, beforeBatch) { this.db = db; this.beforeBatch = beforeBatch; }
  prepare(sql) { return this.db.prepare(sql); }
  withSession() { return this; }
  async batch(statements) {
    const beforeBatch = this.beforeBatch;
    this.beforeBatch = null;
    if (beforeBatch) await beforeBatch();
    return this.db.batch(statements);
  }
}

test('promo arithmetic uses deterministic half-up rounding, caps and line allocation', () => {
  assert.equal(calculatePromoDiscount({ discountType: 'percent', discountValue: 15, maxDiscount: null }, 10), 2);
  assert.equal(calculatePromoDiscount({ discountType: 'percent', discountValue: 80, maxDiscount: 30 }, 100), 30);
  assert.equal(calculatePromoDiscount({ discountType: 'fixed', discountValue: 500, maxDiscount: null }, 120), 120);

  const allocated = allocatePromoDiscount([
    { productId: 2, categoryId: 'cat-b', lineTotal: 100 },
    { productId: 1, categoryId: 'cat-a', lineTotal: 100 },
  ], { discountAmount: 1, categoryIds: [], productIds: [] });
  assert.deepEqual(allocated.map((item) => item.promoDiscountAllocation), [0, 1]);

  const scoped = allocatePromoDiscount([
    { productId: 1, categoryId: 'cat-a', lineTotal: 101 },
    { productId: 2, categoryId: 'cat-b', lineTotal: 199 },
  ], { discountAmount: 10, categoryIds: ['cat-a'], productIds: [] });
  assert.deepEqual(scoped.map((item) => item.promoDiscountAllocation), [10, 0]);
  assert.equal(cumulativePromoRefund(109, 2, 1), 55);
  assert.equal(cumulativePromoRefund(109, 2, 2), 109);
});

test('public validation enforces category scope, dates, minimums and guest policy', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const scoped = insertPromo(db, { code: 'SCOPED10', minOrderAmount: 300 });
  db.sqlite.prepare('INSERT INTO promo_code_categories (promo_code_id, category_id) VALUES (?, ?)').run(scoped.id, 'cat-a');
  const response = await validatePromoEndpoint(promoValidationContext(db, {
    code: 'scoped10',
    items: [{ productKey: 'PROMO-A', quantity: 1 }, { productKey: 'PROMO-B', quantity: 1 }],
  }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.promo, {
    code: 'SCOPED10',
    discountType: 'percent',
    discountValue: 10,
    maxDiscount: null,
    merchandiseSubtotal: 300,
    eligibleSubtotal: 101,
    discountAmount: 10,
    merchandiseTotalAfterPromo: 290,
  });

  insertPromo(db, { code: 'ACCOUNT1', perUserLimit: 1 });
  await assert.rejects(
    validatePromotion(db, {
      code: 'ACCOUNT1',
      items: [{ productId: 1, categoryId: 'cat-a', lineTotal: 101 }],
      merchandiseSubtotal: 101,
      now: '2026-07-17T10:00:00.000Z',
    }),
    (error) => error instanceof PromoValidationError && error.code === 'PROMO_LOGIN_REQUIRED' && error.status === 401,
  );
  const accountPromo = await validatePromotion(db, {
    code: 'ACCOUNT1', userId: 'customer-1',
    items: [{ productId: 1, categoryId: 'cat-a', lineTotal: 101 }],
    merchandiseSubtotal: 101,
    now: '2026-07-17T10:00:00.000Z',
  });
  assert.equal(accountPromo.discountAmount, 10);

  insertPromo(db, { code: 'FUTURE10', startsAt: '2090-01-01T00:00:00.000Z' });
  await assert.rejects(
    validatePromotion(db, {
      code: 'FUTURE10', items: [{ productId: 1, categoryId: 'cat-a', lineTotal: 101 }],
      merchandiseSubtotal: 101, now: '2026-07-17T10:00:00.000Z',
    }),
    (error) => error.code === 'PROMO_NOT_STARTED',
  );
});

test('the final redemption trigger serializes the last total use and rolls back the losing order', async (t) => {
  const db = setup();
  t.after(() => db.close());
  insertPromo(db, { code: 'LASTUSE', discountType: 'fixed', discountValue: 25, totalUseLimit: 1 });
  let innerResponse;
  const racingDb = new BeforeFirstBatchD1(db, async () => {
    innerResponse = await createOrder(orderContext(db, orderBody({ promoCode: 'LASTUSE' })));
  });
  const outerResponse = await createOrder(orderContext(racingDb, orderBody({ promoCode: 'LASTUSE' })));
  assert.equal(innerResponse.status, 201);
  assert.equal(outerResponse.status, 409);
  assert.equal((await outerResponse.json()).error.code, 'PROMO_TOTAL_LIMIT_REACHED');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM promo_redemptions WHERE released_at IS NULL').get().count, 1);
  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory WHERE product_id = 1').get().reserved, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_movements WHERE movement_type = 'reservation'").get().count, 1);
});

test('the final redemption trigger also serializes the per-account limit', async (t) => {
  const db = setup();
  t.after(() => db.close());
  insertPromo(db, { code: 'ONCEACCOUNT', discountType: 'fixed', discountValue: 25, perUserLimit: 1 });
  const cookie = await customerCookie(db);
  let innerResponse;
  const racingDb = new BeforeFirstBatchD1(db, async () => {
    innerResponse = await createOrder(orderContext(db, orderBody({ promoCode: 'ONCEACCOUNT' }), { cookie }));
  });
  const outerResponse = await createOrder(orderContext(racingDb, orderBody({ promoCode: 'ONCEACCOUNT' }), { cookie }));
  assert.equal(innerResponse.status, 201);
  assert.equal(outerResponse.status, 409);
  assert.equal((await outerResponse.json()).error.code, 'PROMO_USER_LIMIT_REACHED');
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT user_id, COUNT(*) AS count FROM promo_redemptions WHERE released_at IS NULL GROUP BY user_id').get() },
    { user_id: 'customer-1', count: 1 },
  );
  assert.equal(db.sqlite.prepare('SELECT reserved FROM inventory WHERE product_id = 1').get().reserved, 1);
});

test('cancellation and reservation expiry release a use so a limited promo can be redeemed again', async (t) => {
  const db = setup();
  t.after(() => db.close());
  insertPromo(db, { code: 'REUSABLE', discountType: 'fixed', discountValue: 20, totalUseLimit: 1 });
  const firstResponse = await createOrder(orderContext(db, orderBody({ promoCode: 'REUSABLE' })));
  const first = (await firstResponse.json()).order;
  await transitionOrder(db, { orderId: first.id, toStatus: 'cancelled', comment: 'Client cancelled' });
  const released = db.sqlite.prepare('SELECT released_at, release_reason FROM promo_redemptions WHERE order_id = ?').get(first.id);
  assert.ok(released.released_at);
  assert.equal(released.release_reason, 'Client cancelled');

  const secondResponse = await createOrder(orderContext(db, orderBody({ promoCode: 'REUSABLE' })));
  assert.equal(secondResponse.status, 201);
  const second = (await secondResponse.json()).order;
  db.sqlite.prepare("UPDATE orders SET reservation_expires_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(second.id);
  const { releaseExpiredReservations } = await import('../functions/_lib/order-lifecycle.js');
  const summary = await releaseExpiredReservations(db, { now: '2026-07-17T00:00:00.000Z' });
  assert.equal(summary.released, 1);
  assert.ok(db.sqlite.prepare('SELECT released_at FROM promo_redemptions WHERE order_id = ?').get(second.id).released_at);
  const thirdResponse = await createOrder(orderContext(db, orderBody({ promoCode: 'REUSABLE' })));
  assert.equal(thirdResponse.status, 201);
});

test('delivery threshold is evaluated before promo and returns reverse the exact stored allocation', async (t) => {
  const db = setup();
  t.after(() => db.close());
  insertPromo(db, { code: 'BIGFIXED', discountType: 'fixed', discountValue: 500 });
  const freeDelivery = await createOrder(orderContext(db, orderBody({
    items: [{ productKey: 'PROMO-2200', quantity: 2 }],
    promoCode: 'BIGFIXED',
    delivery: 'courier',
    customer: { name: 'Ana Promo', phone: '+37368000000', city: 'Chișinău', address: 'Strada Test 1' },
  })));
  const freeOrder = (await freeDelivery.json()).order;
  assert.equal(freeOrder.deliveryFee, 0);
  assert.equal(freeOrder.promoDiscount, 500);
  assert.equal(freeOrder.total, 1700);

  insertPromo(db, { code: 'RETURN137', discountType: 'fixed', discountValue: 137 });
  const response = await createOrder(orderContext(db, orderBody({
    items: [{ productKey: 'PROMO-A', quantity: 1 }, { productKey: 'PROMO-B', quantity: 2 }],
    promoCode: 'RETURN137',
  })));
  const order = (await response.json()).order;
  for (const status of ['confirmed', 'processing', 'ready', 'completed']) {
    await transitionOrder(db, { orderId: order.id, toStatus: status, actorUserId: 'admin-1' });
  }
  const allocations = db.sqlite.prepare(`
    SELECT id, product_id, quantity, promo_discount_allocation
    FROM order_items WHERE order_id = ? ORDER BY product_id
  `).all(order.id);
  assert.equal(allocations.reduce((sum, item) => sum + item.promo_discount_allocation, 0), 137);
  assert.deepEqual(allocations.map((item) => item.promo_discount_allocation), [28, 109]);
  const productTwo = allocations.find((item) => item.product_id === 2);
  const partial = await createOrderReturn(db, {
    orderId: order.id,
    requestKey: 'promo-partial-return-1',
    actorUserId: 'admin-1',
    reason: 'Partial promo return',
    items: [{ orderItemId: productTwo.id, quantity: 1 }],
    now: '2026-07-17T12:00:00.000Z',
  });
  assert.equal(partial.return.promoRefundAmount, 55);
  assert.equal(partial.return.refundAmount, 144);
  await transitionOrder(db, {
    orderId: order.id,
    toStatus: 'returned',
    actorUserId: 'admin-1',
    comment: 'Return remaining items',
    now: '2026-07-17T13:00:00.000Z',
  });
  assert.equal(db.sqlite.prepare('SELECT SUM(promo_refund_amount) AS amount FROM order_returns WHERE order_id = ?').get(order.id).amount, 137);
  assert.equal(db.sqlite.prepare('SELECT SUM(returned_quantity) AS quantity FROM order_items WHERE order_id = ?').get(order.id).quantity, 3);
  assert.deepEqual(
    db.sqlite.prepare('SELECT product_id, on_hand FROM inventory WHERE product_id IN (1, 2) ORDER BY product_id').all().map((row) => ({ ...row })),
    [{ product_id: 1, on_hand: 20 }, { product_id: 2, on_hand: 20 }],
  );
});

test('admin promo CRUD preserves scopes, revision guards, metrics and linked order history', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const createResponse = await createPromo(adminContext(db, '/api/admin/promos', {
    method: 'POST',
    body: {
      code: 'ADMIN20', discountType: 'percent', discountValue: 20, maxDiscount: 50,
      minOrderAmount: 100, startsAt: null, endsAt: null, totalUseLimit: 10,
      perUserLimit: null, isActive: true, categoryIds: ['cat-a'], productIds: [2],
    },
  }));
  assert.equal(createResponse.status, 201);
  let promo = (await createResponse.json()).promo;
  assert.deepEqual(promo.categoryIds, ['cat-a']);
  assert.deepEqual(promo.productIds, [2]);

  const orderResponse = await createOrder(orderContext(db, orderBody({
    promoCode: 'ADMIN20',
    items: [{ productKey: 'PROMO-A', quantity: 1 }, { productKey: 'PROMO-B', quantity: 1 }],
  })));
  assert.equal(orderResponse.status, 201);
  const listResponse = await listPromos(adminContext(db, '/api/admin/promos?state=active&q=ADMIN'));
  const list = await listResponse.json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].usageCount, 1);
  assert.equal(list.items[0].discountSum, 50);
  assert.equal(list.items[0].categoryScopeCount, 1);
  assert.equal(list.items[0].productScopeCount, 1);

  const detailResponse = await getPromo(adminContext(db, `/api/admin/promos/${promo.id}`, { params: { id: promo.id } }));
  promo = (await detailResponse.json()).promo;
  assert.equal(promo.orders.length, 1);
  assert.equal(promo.orders[0].discountAmount, 50);

  const staleRevision = promo.revision;
  const updateResponse = await updatePromo(adminContext(db, `/api/admin/promos/${promo.id}`, {
    method: 'PATCH', params: { id: promo.id },
    body: { revision: promo.revision, code: 'ADMIN25', discountValue: 25, categoryIds: [], productIds: [] },
  }));
  assert.equal(updateResponse.status, 200);
  promo = (await updateResponse.json()).promo;
  assert.equal(promo.code, 'ADMIN25');
  assert.deepEqual(promo.categoryIds, []);
  assert.deepEqual(promo.productIds, []);
  const historicalOrder = await getAdminOrder(db, promo.orders[0].id);
  assert.equal(historicalOrder.promoCode, 'ADMIN20');
  const historicalListResponse = await listAdminOrders(adminContext(db, '/api/admin/orders?limit=30'));
  const historicalList = await historicalListResponse.json();
  assert.equal(historicalList.items[0].promoCode, 'ADMIN20');

  const staleResponse = await updatePromo(adminContext(db, `/api/admin/promos/${promo.id}`, {
    method: 'PATCH', params: { id: promo.id },
    body: { revision: staleRevision, discountValue: 30 },
  }));
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).error.code, 'PROMO_REVISION_CONFLICT');

  const deactivateResponse = await deactivatePromo(adminContext(db, `/api/admin/promos/${promo.id}`, {
    method: 'DELETE', params: { id: promo.id }, body: { revision: promo.revision },
  }));
  assert.equal(deactivateResponse.status, 200);
  assert.equal((await deactivateResponse.json()).promo.isActive, false);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE entity_type = 'promo_code'").get().count, 3);
});

test('maximum promo scopes are chunked below the D1 binding limit on create and update', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const scopes = insertMaximumScopes(db);
  const createDb = new BudgetGuardD1(db);
  const createResponse = await createPromo(adminContext(createDb, '/api/admin/promos', {
    method: 'POST',
    body: {
      code: 'MAXSCOPE', discountType: 'percent', discountValue: 10,
      isActive: true, categoryIds: scopes.categoryIds, productIds: scopes.productIds,
    },
  }));
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).promo;
  assert.equal(created.categoryIds.length, 100);
  assert.equal(created.productIds.length, 100);
  assert.ok(createDb.maxObservedBindings <= 100);

  const updateDb = new BudgetGuardD1(db);
  const updateResponse = await updatePromo(adminContext(updateDb, `/api/admin/promos/${created.id}`, {
    method: 'PATCH', params: { id: created.id },
    body: {
      revision: created.revision,
      categoryIds: [...scopes.categoryIds].reverse(),
      productIds: [...scopes.productIds].reverse(),
    },
  }));
  assert.equal(updateResponse.status, 200);
  const updated = (await updateResponse.json()).promo;
  assert.equal(updated.categoryIds.length, 100);
  assert.equal(updated.productIds.length, 100);
  assert.ok(updateDb.maxObservedBindings <= 100);
});
