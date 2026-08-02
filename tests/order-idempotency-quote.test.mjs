import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { newSessionRecord } from '../functions/_lib/customer-auth.js';
import { fingerprintOrderRequest } from '../functions/_lib/order-idempotency.js';
import { normalizeOrderRequest } from '../functions/_lib/order-core.js';
import { onRequestPost as createOrder } from '../functions/api/orders.js';
import { submitOrderRequest } from '../src/order-api.js';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';
import { withOrderContract } from './helpers/order-fixture.mjs';

const migrations = [
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
  '0014_catalog_discounts_and_promo_brands.sql',
];
const schema = migrations.map((name) => readFileSync(
  new URL(`../migrations/${name}`, import.meta.url),
  'utf8',
)).join('\n');

function setup({ price = 100, oldPrice = 120, onHand = 20 } = {}) {
  const db = new SqliteD1(schema);
  db.sqlite.exec(`
    INSERT INTO categories (id, slug, name_ro, name_ru)
    VALUES ('test', 'test', 'Test', 'Test');
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, brand, name_ro, name_ru,
      price, old_price, admin_revision
    ) VALUES (
      1, 'P1', 'P1', 'p1', 'test', 'Brand', 'Produs', 'Товар',
      ${price}, ${oldPrice}, 'product:initial'
    );
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, admin_revision)
    VALUES (1, 1, ${onHand}, 0, 'inventory:initial');
  `);
  return db;
}

const baseBody = (overrides = {}) => ({
  items: [{ productKey: 'P1', quantity: 1 }],
  customer: { name: 'Ana Retry', phone: '+37368000000', email: 'ana@example.test' },
  delivery: 'pickup',
  payment: 'cash',
  lang: 'ro',
  turnstileToken: 'turnstile-first',
  ...overrides,
});

function endpointRequest(db, body, {
  env = {}, cookie = '', origin = 'https://shop.test', idempotencyHeader = body.idempotencyKey,
} = {}) {
  const headers = new Headers({
    'content-type': 'application/json',
    origin,
    'sec-fetch-site': 'same-origin',
    ...(idempotencyHeader ? { 'idempotency-key': idempotencyHeader } : {}),
    ...(cookie ? { cookie } : {}),
  });
  return createOrder({
    env: { DB: db, ENVIRONMENT: 'local', ...env },
    data: { requestId: crypto.randomUUID() },
    request: new Request('https://shop.test/api/orders', {
      method: 'POST', headers, body: JSON.stringify(body),
    }),
  });
}

const counts = (db) => ({
  orders: db.sqlite.prepare('SELECT COUNT(*) AS count FROM orders').get().count,
  idempotency: db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_idempotency').get().count,
  movements: db.sqlite.prepare('SELECT COUNT(*) AS count FROM inventory_movements').get().count,
  reserved: db.sqlite.prepare('SELECT reserved FROM inventory WHERE product_id = 1').get().reserved,
});

class BeforeFirstBatchD1 {
  constructor(db, mutate) {
    this.db = db;
    this.mutate = mutate;
    this.mutated = false;
    this.sessionModes = [];
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  withSession(mode) {
    this.sessionModes.push(mode);
    return this;
  }

  batch(statements) {
    if (!this.mutated) {
      this.mutated = true;
      this.mutate(this.db.sqlite);
    }
    return this.db.batch(statements);
  }
}

test('lost successful response is retried by the client with one key and creates exactly one order', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const request = withOrderContract(db, baseBody());
  let attempts = 0;
  const fetchImpl = async (url, options) => {
    attempts += 1;
    const headers = new Headers(options.headers);
    headers.set('origin', 'https://shop.test');
    headers.set('sec-fetch-site', 'same-origin');
    const response = await createOrder({
      env: { DB: db, ENVIRONMENT: 'local' },
      request: new Request(new URL(url, 'https://shop.test'), { ...options, headers }),
    });
    if (attempts === 1) throw new TypeError('response lost after server commit');
    return response;
  };

  await assert.rejects(submitOrderRequest(request, fetchImpl), (error) => error.code === 'NETWORK_ERROR');
  const replayed = await submitOrderRequest(request, fetchImpl);

  assert.equal(attempts, 2);
  assert.equal(replayed.id, db.sqlite.prepare('SELECT id FROM orders').get().id);
  assert.equal(Object.hasOwn(replayed, 'customer'), false);
  assert.deepEqual(counts(db), { orders: 1, idempotency: 1, movements: 1, reserved: 1 });
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM promo_redemptions').get().count, 0);
});

test('immutable idempotency response excludes PII and request matching uses a secret-keyed fingerprint', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const body = withOrderContract(db, baseBody({
    customer: {
      name: 'Private Customer',
      phone: '+37361234567',
      email: 'private.customer@example.test',
      city: 'Private City',
      address: 'Private Street 7',
      comment: 'Private delivery note',
    },
    delivery: 'courier',
  }));
  const response = await endpointRequest(db, body);
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(Object.hasOwn(payload.order, 'customer'), false);

  const record = db.sqlite.prepare(`
    SELECT request_fingerprint, response_json FROM order_idempotency
  `).get();
  assert.match(record.request_fingerprint, /^[0-9a-f]{64}$/);
  const persisted = record.response_json;
  for (const forbidden of [
    'Private Customer', '+37361234567', 'private.customer@example.test',
    'Private City', 'Private Street 7', 'Private delivery note',
  ]) {
    assert.equal(persisted.includes(forbidden), false);
  }
  db.sqlite.prepare(`
    INSERT INTO orders (
      id, order_no, user_id, status, language, customer_name, customer_phone,
      customer_email, city, address, customer_comment, internal_comment,
      delivery_method, delivery_label, delivery_fee, payment_method, payment_label,
      items_subtotal, catalog_discount, promo_discount, total_amount,
      reservation_expires_at, created_at, updated_at
    )
    SELECT
      'privacy-guard-order', 'NM-PRIVACY-GUARD', user_id, status, language,
      customer_name, customer_phone, customer_email, city, address,
      customer_comment, internal_comment, delivery_method, delivery_label,
      delivery_fee, payment_method, payment_label, items_subtotal,
      catalog_discount, promo_discount, total_amount, reservation_expires_at,
      created_at, updated_at
    FROM orders LIMIT 1
  `).run();
  assert.throws(() => db.sqlite.prepare(`
    INSERT INTO order_idempotency (
      idempotency_key, request_fingerprint, order_id, response_json
    ) VALUES (?, ?, ?, ?)
  `).run(
    '8de8250f-8190-4e22-8c80-52d4d63a7355',
    'a'.repeat(64),
    'privacy-guard-order',
    JSON.stringify({ id: 'privacy-guard-order', customer: { phone: '+37361234567' } }),
  ), /CHECK constraint failed/i);

  const normalized = normalizeOrderRequest(body, { requireExpectedQuote: true });
  const first = await fingerprintOrderRequest(normalized, null, {
    ENVIRONMENT: 'production', AUTH_FINGERPRINT_SALT: 'first-independent-secret',
  });
  const second = await fingerprintOrderRequest(normalized, null, {
    ENVIRONMENT: 'production', AUTH_FINGERPRINT_SALT: 'second-independent-secret',
  });
  assert.notEqual(first, second);
  await assert.rejects(
    fingerprintOrderRequest(normalized, null, { ENVIRONMENT: 'production' }),
    (error) => error.code === 'IDEMPOTENCY_NOT_CONFIGURED' && error.status === 503,
  );
});

test('same-key races replay one commit while a different fingerprint is rejected', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const body = withOrderContract(db, baseBody());
  const responses = await Promise.all([endpointRequest(db, body), endpointRequest(db, body)]);
  const payloads = await Promise.all(responses.map((response) => response.json()));

  assert.deepEqual(responses.map((response) => response.status), [201, 201]);
  assert.equal(new Set(payloads.map((payload) => payload.order.id)).size, 1);
  assert.equal(responses.filter((response) => response.headers.get('idempotency-replayed') === 'true').length, 1);
  assert.deepEqual(counts(db), { orders: 1, idempotency: 1, movements: 1, reserved: 1 });

  const changed = { ...body, customer: { ...body.customer, phone: '+37369000000' } };
  const conflict = await endpointRequest(db, changed);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.deepEqual(counts(db), { orders: 1, idempotency: 1, movements: 1, reserved: 1 });
});

test('committed replay precedes Turnstile, but still enforces same-origin and exact intent', async (t) => {
  const db = setup();
  t.after(() => db.close());
  let verifications = 0;
  const env = {
    ENVIRONMENT: 'preview',
    AUTH_FINGERPRINT_SALT: 'preview-idempotency-test-secret',
    TURNSTILE_SECRET_KEY: 'test-secret',
    TURNSTILE_HOSTNAMES: 'shop.test',
    TURNSTILE_FETCH: async () => {
      verifications += 1;
      return Response.json({ success: verifications === 1, action: 'order', hostname: 'shop.test' });
    },
  };
  const body = withOrderContract(db, baseBody());
  const first = await endpointRequest(db, body, { env });
  assert.equal(first.status, 201);

  const retry = await endpointRequest(db, { ...body, turnstileToken: 'already-consumed-token' }, { env });
  assert.equal(retry.status, 201);
  assert.equal(retry.headers.get('idempotency-replayed'), 'true');
  assert.equal(verifications, 1, 'a committed replay must not consume another Turnstile token');

  const changed = await endpointRequest(db, {
    ...body,
    customer: { ...body.customer, name: 'Different Customer' },
    turnstileToken: 'not-verified',
  }, { env });
  assert.equal(changed.status, 409);
  assert.equal(verifications, 1, 'fingerprint conflicts must be rejected before Turnstile');

  const crossOrigin = await endpointRequest(db, body, { env, origin: 'https://evil.test' });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).error.code, 'CROSS_ORIGIN_REQUEST');
});

test('account identity is part of the persisted request fingerprint', async (t) => {
  const db = setup();
  t.after(() => db.close());
  db.sqlite.prepare(`
    INSERT INTO users (id, email, name, role, status, password_hash)
    VALUES ('customer-1', 'customer@example.test', 'Customer', 'customer', 'active', 'unused')
  `).run();
  const session = await newSessionRecord(
    db,
    'customer-1',
    new Request('https://shop.test/login', { headers: { 'user-agent': 'idempotency-test' } }),
    { ENVIRONMENT: 'local' },
  );
  await session.statement.run();
  const cookie = `nm_session=${session.token}`;
  const body = withOrderContract(db, baseBody());

  assert.equal((await endpointRequest(db, body, { cookie })).status, 201);
  assert.equal((await endpointRequest(db, body, { cookie })).status, 201);
  const guest = await endpointRequest(db, body);
  assert.equal(guest.status, 409);
  assert.equal((await guest.json()).error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(db.sqlite.prepare('SELECT user_id FROM orders').get().user_id, 'customer-1');
});

test('changed price returns a safe quote, preserves the cart reservation, and accepts reviewed resubmission', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const body = withOrderContract(db, baseBody());
  db.sqlite.prepare("UPDATE products SET price = 130, admin_revision = 'price:changed' WHERE id = 1").run();

  const changed = await endpointRequest(db, body);
  const payload = await changed.json();
  assert.equal(changed.status, 409);
  assert.equal(payload.error.code, 'ORDER_QUOTE_CHANGED');
  assert.equal(payload.error.details.currentQuote.items[0].unitPrice, 130);
  assert.deepEqual(counts(db), { orders: 0, idempotency: 0, movements: 0, reserved: 0 });

  const reviewed = await endpointRequest(db, { ...body, expectedQuote: payload.error.details.currentQuote });
  assert.equal(reviewed.status, 201);
  assert.deepEqual(counts(db), { orders: 1, idempotency: 1, movements: 1, reserved: 1 });
});

test('catalog price cannot change between quote validation and the atomic order batch', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const body = withOrderContract(db, baseBody());
  const racingDb = new BeforeFirstBatchD1(db, (sqlite) => {
    sqlite.prepare(`
      UPDATE products
      SET price = 130, old_price = 130, admin_revision = 'price:between-read-and-batch'
      WHERE id = 1
    `).run();
  });

  const response = await endpointRequest(racingDb, body);
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.error.code, 'ORDER_QUOTE_CHANGED');
  assert.equal(payload.error.details.currentQuote.items[0].unitPrice, 130);
  assert.equal(payload.error.details.currentQuote.items[0].listPrice, 130);
  assert.deepEqual(counts(db), { orders: 0, idempotency: 0, movements: 0, reserved: 0 });
  assert.deepEqual(
    racingDb.sessionModes,
    ['first-primary', 'first-primary'],
    'post-batch conflict resolution must start a fresh primary session',
  );
});

test('catalog deactivation between quote validation and the batch rolls back the whole order', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const body = withOrderContract(db, baseBody());
  const racingDb = new BeforeFirstBatchD1(db, (sqlite) => {
    sqlite.prepare("UPDATE categories SET is_active = 0 WHERE id = 'test'").run();
  });

  const response = await endpointRequest(racingDb, body);
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.error.code, 'PRODUCT_NOT_FOUND');
  assert.deepEqual(counts(db), { orders: 0, idempotency: 0, movements: 0, reserved: 0 });
});

test('missing inventory row between quote validation and the batch cannot create an unreserved order', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const body = withOrderContract(db, baseBody());
  const racingDb = new BeforeFirstBatchD1(db, (sqlite) => {
    sqlite.prepare('DELETE FROM inventory WHERE product_id = 1 AND warehouse_id = 1').run();
  });

  const response = await endpointRequest(racingDb, body);
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.error.code, 'PRODUCT_NOT_FOUND');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_idempotency').get().count, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_items').get().count, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM inventory_movements').get().count, 0);
});

test('crossing 2200 changes courier delivery to free and requires review', async (t) => {
  const db = setup({ price: 2199, oldPrice: 2199 });
  t.after(() => db.close());
  const body = withOrderContract(db, baseBody({
    delivery: 'courier',
    customer: {
      name: 'Ana Delivery', phone: '+37368000000', city: 'Chisinau', address: 'Test 1',
    },
  }));
  assert.equal(body.expectedQuote.deliveryFee, 70);
  db.sqlite.prepare("UPDATE products SET price = 2200, old_price = 2200, admin_revision = 'threshold:changed' WHERE id = 1").run();

  const changed = await endpointRequest(db, body);
  const payload = await changed.json();
  assert.equal(changed.status, 409);
  assert.equal(payload.error.details.currentQuote.itemsSubtotal, 2200);
  assert.equal(payload.error.details.currentQuote.deliveryFee, 0);
  assert.equal(payload.error.details.currentQuote.totalAmount, 2200);
  assert.deepEqual(counts(db), { orders: 0, idempotency: 0, movements: 0, reserved: 0 });
});

test('changed promo amount is never silently charged and reviewed quote keeps one redemption', async (t) => {
  const db = setup({ price: 1000, oldPrice: 1000 });
  t.after(() => db.close());
  db.sqlite.prepare(`
    INSERT INTO promo_codes (
      id, code, discount_type, discount_value, is_active, admin_revision
    ) VALUES ('promo-1', 'SAVE10', 'percent', 10, 1, 'promo:initial')
  `).run();
  const body = withOrderContract(db, baseBody({ promoCode: 'SAVE10' }));
  assert.equal(body.expectedQuote.promoDiscount, 100);
  db.sqlite.prepare("UPDATE promo_codes SET discount_value = 20, admin_revision = 'promo:changed' WHERE id = 'promo-1'").run();

  const changed = await endpointRequest(db, body);
  const payload = await changed.json();
  assert.equal(changed.status, 409);
  assert.equal(payload.error.details.currentQuote.promoDiscount, 200);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM promo_redemptions').get().count, 0);

  const reviewed = await endpointRequest(db, { ...body, expectedQuote: payload.error.details.currentQuote });
  assert.equal(reviewed.status, 201);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM promo_redemptions').get().count, 1);
  assert.equal(db.sqlite.prepare('SELECT discount_amount FROM promo_redemptions').get().discount_amount, 200);
});
