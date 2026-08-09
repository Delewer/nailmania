import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BudgetGuardD1, SqliteD1 } from './helpers/sqlite-d1.mjs';
import { onRequestPost } from '../functions/api/orders.js';
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
  readFileSync(new URL('../migrations/0014_catalog_discounts_and_promo_brands.sql', import.meta.url), 'utf8'),
].join('\n');

function setup({ onHand = 3, oldPrice = 120 } = {}) {
  const db = new SqliteD1(schema);
  db.sqlite.exec(`
    INSERT INTO categories (id, slug, name_ro, name_ru)
    VALUES ('test', 'test', 'Test', 'Test');
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, brand, name_ro, name_ru, price, old_price
    ) VALUES (1, 'P1', 'SKU-1', 'product-1', 'test', 'Brand', 'Produs', 'Товар', 100, ${oldPrice});
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved)
    VALUES (1, 1, ${onHand}, 0);
  `);
  return db;
}

function setupMany(count) {
  const db = new SqliteD1(schema);
  db.sqlite.exec(`
    INSERT INTO categories (id, slug, name_ro, name_ru)
    VALUES ('test', 'test', 'Test', 'Test');
  `);
  for (let id = 1; id <= count; id += 1) {
    db.sqlite.prepare(`
      INSERT INTO products (
        id, catalog_key, sku, slug, category_id, brand, name_ro, name_ru, price, old_price
      ) VALUES (?, ?, ?, ?, 'test', 'Brand', ?, ?, 100, 120)
    `).run(id, `P${id}`, `SKU-${id}`, `product-${id}`, `Product ${id}`, `Product ${id}`);
    db.sqlite.prepare(`
      INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved)
      VALUES (?, 1, 5, 0)
    `).run(id);
  }
  return db;
}

const orderBody = (overrides = {}) => ({
  items: [{ productKey: 'P1', quantity: 1, price: 1 }],
  customer: { name: 'Ana Test', phone: '+37368000000', email: 'ANA@EXAMPLE.COM' },
  delivery: 'pickup',
  payment: 'cash',
  lang: 'ro',
  total: 1,
  ...overrides,
});

function postOrder(db, body, options = {}) {
  const contracted = withOrderContract(db, body, { idempotencyKey: options.idempotencyKey });
  const context = {
    request: new Request('https://example.test/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(contracted),
    }),
    env: { DB: db, ENVIRONMENT: 'local', ...options.env },
    data: { requestId: options.requestId || 'req-order-test' },
  };
  if (options.waitUntil) context.waitUntil = options.waitUntil;
  return onRequestPost(context);
}

test('real POST /api/orders handler persists a server-priced order and reservation', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const response = await postOrder(db, orderBody({
    items: [{ productKey: 'P1', quantity: 2, price: 1 }],
    customer: {
      name: 'Ana Test', phone: '+37368000000', email: 'ANA@EXAMPLE.COM',
      city: 'Chișinău', address: 'Strada Test 1',
    },
    delivery: 'courier',
    total: 2,
  }));
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(payload.order.total, 270);
  assert.deepEqual(
    { ...db.sqlite.prepare(`
      SELECT status, customer_email, items_subtotal, catalog_discount, delivery_fee, total_amount
      FROM orders
    `).get() },
    {
      status: 'pending', customer_email: 'ana@example.com', items_subtotal: 200,
      catalog_discount: 40, delivery_fee: 70, total_amount: 270,
    },
  );
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT unit_price, list_price, quantity, line_total FROM order_items').get() },
    { unit_price: 100, list_price: 120, quantity: 2, line_total: 200 },
  );
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = 1').get() },
    { on_hand: 3, reserved: 2 },
  );
  assert.deepEqual(
    { ...db.sqlite.prepare(`
      SELECT movement_type, delta_reserved, balance_on_hand, balance_reserved
      FROM inventory_movements
    `).get() },
    { movement_type: 'reservation', delta_reserved: 2, balance_on_hand: 3, balance_reserved: 2 },
  );
  assert.equal(db.sqlite.prepare('SELECT revision FROM catalog_cache_state WHERE id = 1').get().revision, 2);
});

test('committed order notifies both Telegram recipients and emails the customer exactly once', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const pending = [];
  const telegramChats = [];
  const emails = [];
  const options = {
    idempotencyKey: '8fc7908b-50a7-4fb0-b08c-d422633f9175',
    waitUntil(promise) { pending.push(promise); },
    env: {
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_CHAT_ID: 'primary-chat',
      TELEGRAM_SECONDARY_CHAT_ID: 'secondary-chat',
      TELEGRAM_FETCH: async (_url, init) => {
        telegramChats.push(JSON.parse(init.body).chat_id);
        return Response.json({ ok: true });
      },
      CUSTOMER_EMAIL_SEND: async (message) => emails.push(message),
    },
  };

  const first = await postOrder(db, orderBody(), options);
  assert.equal(first.status, 201);
  await Promise.all(pending.splice(0));
  assert.deepEqual(telegramChats.sort(), ['primary-chat', 'secondary-chat']);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, 'ana@example.com');
  assert.equal(emails[0].order.total, 100);
  assert.deepEqual(emails[0].order.items.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    lineTotal: item.lineTotal,
  })), [{ name: 'Produs', quantity: 1, lineTotal: 100 }]);
  assert.deepEqual(
    db.sqlite.prepare(`
      SELECT channel, COUNT(*) AS count FROM notification_attempts GROUP BY channel ORDER BY channel
    `).all().map((row) => ({ ...row })),
    [{ channel: 'email', count: 1 }, { channel: 'telegram', count: 2 }],
  );

  const replay = await postOrder(db, orderBody(), options);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  await Promise.all(pending.splice(0));
  assert.equal(telegramChats.length, 2);
  assert.equal(emails.length, 1);
});

test('order item inserts stay within the D1 binding budget for eight distinct products', async (t) => {
  const db = setupMany(8);
  t.after(() => db.close());
  const guardedDb = new BudgetGuardD1(db);
  const response = await postOrder(guardedDb, orderBody({
    items: Array.from({ length: 8 }, (_, index) => ({ productKey: `P${index + 1}`, quantity: 1 })),
  }));
  assert.equal(response.status, 201);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_items').get().count, 8);
  assert.ok(guardedDb.maxObservedBindings <= 100);
});

test('two concurrent POST /api/orders handlers cannot reserve the same last unit', async (t) => {
  const db = setup({ onHand: 1, oldPrice: 0 });
  t.after(() => db.close());
  const responses = await Promise.all([postOrder(db, orderBody()), postOrder(db, orderBody())]);
  const payloads = await Promise.all(responses.map((response) => response.json()));

  assert.deepEqual(responses.map(({ status }) => status).sort((a, b) => a - b), [201, 409]);
  assert.equal(payloads.find((payload) => !payload.ok)?.error.code, 'INSUFFICIENT_STOCK');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_items').get().count, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM inventory_movements').get().count, 1);
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = 1').get() },
    { on_hand: 1, reserved: 1 },
  );
});
