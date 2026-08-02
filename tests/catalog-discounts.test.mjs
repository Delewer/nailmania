import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAdminDiscount, AdminDiscountError } from '../functions/_lib/admin-discounts.js';
import {
  onRequestGet as listDiscounts,
  onRequestPost as createDiscount,
} from '../functions/api/admin/discounts/index.js';
import {
  onRequestDelete as deactivateDiscount,
  onRequestGet as getDiscount,
  onRequestPatch as updateDiscount,
} from '../functions/api/admin/discounts/[id].js';
import { onRequestPost as previewDiscount } from '../functions/api/admin/discounts/preview.js';
import { onRequestGet as listCatalogScopes } from '../functions/api/admin/catalog-scopes.js';
import { onRequestGet as listProducts } from '../functions/api/products/index.js';
import { onRequestPost as createOrder } from '../functions/api/orders.js';
import { fullSchema } from './helpers/full-schema.mjs';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';
import { withOrderContract } from './helpers/order-fixture.mjs';

function setup() {
  const db = new SqliteD1(fullSchema);
  db.sqlite.exec(`
    INSERT INTO categories (id, slug, name_ro, name_ru, sort_order)
    VALUES ('cat-a', 'cat-a', 'Categoria A', 'Категория A', 1),
           ('cat-b', 'cat-b', 'Categoria B', 'Категория B', 2),
           ('cat-c', 'cat-c', 'Categoria C', 'Категория C', 3);
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, brand, name_ro, name_ru,
      price, old_price, source_type, admin_revision
    ) VALUES
      (1, 'DISC-A', 'DISC-A', 'disc-a', 'cat-a', 'Brand A', 'Produs A', 'Товар A', 100, 0, 'import', 'product:1'),
      (2, 'DISC-B', 'DISC-B', 'disc-b', 'cat-b', 'Brand B', 'Produs B', 'Товар B', 200, 250, 'import', 'product:2'),
      (3, 'DISC-C', 'DISC-C', 'disc-c', 'cat-b', 'Brand C', 'Produs C', 'Товар C', 100, 0, 'import', 'product:3'),
      (4, 'DISC-THRESHOLD', 'DISC-THRESHOLD', 'disc-threshold', 'cat-c', 'Brand D', 'Produs prag', 'Порог', 2500, 0, 'import', 'product:4');
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, admin_revision)
    VALUES (1, 1, 20, 0, 'inventory:1'), (2, 1, 20, 0, 'inventory:2'),
           (3, 1, 20, 0, 'inventory:3'), (4, 1, 20, 0, 'inventory:4');
    INSERT INTO users (id, email, name, role, status)
    VALUES ('admin-1', 'admin@example.test', 'Admin', 'admin', 'active'),
           ('manager-1', 'manager@example.test', 'Manager', 'manager', 'active'),
           ('customer-1', 'customer@example.test', 'Customer', 'customer', 'active');
  `);
  return db;
}

function adminContext(db, path, {
  method = 'GET', body, params = {}, email = 'manager@example.test',
} = {}) {
  const headers = new Headers({ authorization: 'Bearer discount-test-token' });
  if (method !== 'GET') headers.set('origin', 'http://127.0.0.1:8788');
  if (body !== undefined) headers.set('content-type', 'application/json');
  return {
    env: {
      DB: db,
      ENVIRONMENT: 'local',
      ADMIN_DEV_TOKEN: 'discount-test-token',
      ADMIN_DEV_EMAIL: email,
    },
    params,
    request: new Request(`http://127.0.0.1:8788${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  };
}

function orderContext(db, body) {
  const contracted = withOrderContract(db, body);
  return {
    env: { DB: db, ENVIRONMENT: 'local' },
    data: { requestId: crypto.randomUUID() },
    request: new Request('http://127.0.0.1:8788/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(contracted),
    }),
  };
}

const discountBody = (overrides = {}) => ({
  name: 'Reducere test',
  percentage: 20,
  startsAt: null,
  endsAt: null,
  isActive: true,
  categoryIds: ['cat-a'],
  brands: ['brand b'],
  productIds: [3],
  ...overrides,
});

test('catalog discount definition requires an explicit scope and a safe percentage', () => {
  assert.throws(
    () => normalizeAdminDiscount(discountBody({ categoryIds: [], brands: [], productIds: [] })),
    (error) => error instanceof AdminDiscountError && error.code === 'DISCOUNT_SCOPE_REQUIRED',
  );
  assert.throws(
    () => normalizeAdminDiscount(discountBody({ percentage: 100 })),
    (error) => error.code === 'INVALID_DISCOUNT_PERCENTAGE',
  );
});

test('manager can preview and manage dynamic product, category and brand discount scopes', async (t) => {
  const db = setup();
  t.after(() => db.close());

  const scopesResponse = await listCatalogScopes(adminContext(db, '/api/admin/catalog-scopes'));
  assert.equal(scopesResponse.status, 200);
  const scopes = await scopesResponse.json();
  assert.deepEqual(scopes.categories.map((category) => category.id), ['cat-a', 'cat-b', 'cat-c']);
  assert.equal(scopes.brands.find((brand) => brand.name === 'Brand B').productCount, 1);

  const previewResponse = await previewDiscount(adminContext(db, '/api/admin/discounts/preview', {
    method: 'POST', body: discountBody(),
  }));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.affectedCount, 3);
  assert.deepEqual(preview.sample.map((product) => product.previewPrice).sort((a, b) => a - b), [80, 80, 160]);

  const createResponse = await createDiscount(adminContext(db, '/api/admin/discounts', {
    method: 'POST', body: discountBody(),
  }));
  assert.equal(createResponse.status, 201);
  let discount = (await createResponse.json()).discount;
  assert.deepEqual(discount.categoryIds, ['cat-a']);
  assert.deepEqual(discount.brands, ['Brand B']);
  assert.deepEqual(discount.productIds, [3]);
  assert.equal(discount.affectedProductCount, 3);

  const prices = db.sqlite.prepare(`
    SELECT product_id, effective_price, effective_old_price, discount_percentage
    FROM product_catalog_prices ORDER BY product_id
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(prices, [
    { product_id: 1, effective_price: 80, effective_old_price: 100, discount_percentage: 20 },
    { product_id: 2, effective_price: 160, effective_old_price: 250, discount_percentage: 20 },
    { product_id: 3, effective_price: 80, effective_old_price: 100, discount_percentage: 20 },
    { product_id: 4, effective_price: 2500, effective_old_price: 0, discount_percentage: 0 },
  ]);
  assert.deepEqual(
    db.sqlite.prepare('SELECT id, source_type, admin_revision, price, old_price FROM products ORDER BY id').all().map((row) => ({ ...row })),
    [
      { id: 1, source_type: 'import', admin_revision: 'product:1', price: 100, old_price: 0 },
      { id: 2, source_type: 'import', admin_revision: 'product:2', price: 200, old_price: 250 },
      { id: 3, source_type: 'import', admin_revision: 'product:3', price: 100, old_price: 0 },
      { id: 4, source_type: 'import', admin_revision: 'product:4', price: 2500, old_price: 0 },
    ],
  );

  db.sqlite.exec(`
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, brand, name_ro, price, source_type, admin_revision
    ) VALUES (5, 'DISC-B-NEW', 'DISC-B-NEW', 'disc-b-new', 'cat-c', 'Brand B', 'Produs B nou', 50, 'import', 'product:5');
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, admin_revision)
    VALUES (5, 1, 5, 0, 'inventory:5');
  `);
  assert.equal(db.sqlite.prepare('SELECT effective_price FROM product_catalog_prices WHERE product_id = 5').get().effective_price, 40);

  const overlapResponse = await createDiscount(adminContext(db, '/api/admin/discounts', {
    method: 'POST',
    body: discountBody({ name: 'Mai mare', percentage: 30, categoryIds: [], brands: [], productIds: [1] }),
  }));
  const overlap = (await overlapResponse.json()).discount;
  assert.equal(db.sqlite.prepare('SELECT effective_price FROM product_catalog_prices WHERE product_id = 1').get().effective_price, 70);

  const overlapOff = await deactivateDiscount(adminContext(db, `/api/admin/discounts/${overlap.id}`, {
    method: 'DELETE', params: { id: overlap.id }, body: { revision: overlap.revision },
  }));
  assert.equal(overlapOff.status, 200);
  assert.equal(db.sqlite.prepare('SELECT effective_price FROM product_catalog_prices WHERE product_id = 1').get().effective_price, 80);

  const staleRevision = discount.revision;
  const updateResponse = await updateDiscount(adminContext(db, `/api/admin/discounts/${discount.id}`, {
    method: 'PATCH', params: { id: discount.id }, body: { revision: discount.revision, percentage: 25 },
  }));
  assert.equal(updateResponse.status, 200);
  discount = (await updateResponse.json()).discount;

  const lowerPreviewResponse = await previewDiscount(adminContext(db, '/api/admin/discounts/preview', {
    method: 'POST',
    body: discountBody({
      discountId: discount.id,
      revision: discount.revision,
      percentage: 10,
    }),
  }));
  assert.equal(lowerPreviewResponse.status, 200);
  const lowerPreview = await lowerPreviewResponse.json();
  assert.equal(lowerPreview.discountId, discount.id);
  assert.equal(lowerPreview.revision, discount.revision);
  const lowerProduct = lowerPreview.sample.find((product) => product.id === 1);
  assert.deepEqual(
    { currentPrice: lowerProduct.currentPrice, previewPrice: lowerProduct.previewPrice },
    { currentPrice: 75, previewPrice: 90 },
  );

  const stalePreviewResponse = await previewDiscount(adminContext(db, '/api/admin/discounts/preview', {
    method: 'POST',
    body: discountBody({
      discountId: discount.id,
      revision: staleRevision,
      percentage: 10,
    }),
  }));
  assert.equal(stalePreviewResponse.status, 409);
  assert.equal((await stalePreviewResponse.json()).error.code, 'DISCOUNT_REVISION_CONFLICT');

  const staleResponse = await updateDiscount(adminContext(db, `/api/admin/discounts/${discount.id}`, {
    method: 'PATCH', params: { id: discount.id }, body: { revision: staleRevision, percentage: 15 },
  }));
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).error.code, 'DISCOUNT_REVISION_CONFLICT');

  const listResponse = await listDiscounts(adminContext(db, '/api/admin/discounts?state=active'));
  assert.equal(listResponse.status, 200);
  assert.equal((await listResponse.json()).items.length, 1);
  const detailResponse = await getDiscount(adminContext(db, `/api/admin/discounts/${discount.id}`, {
    params: { id: discount.id },
  }));
  assert.equal(detailResponse.status, 200);

  const deactivateResponse = await deactivateDiscount(adminContext(db, `/api/admin/discounts/${discount.id}`, {
    method: 'DELETE', params: { id: discount.id }, body: { revision: discount.revision },
  }));
  assert.equal(deactivateResponse.status, 200);
  assert.equal(db.sqlite.prepare('SELECT effective_price FROM product_catalog_prices WHERE product_id = 1').get().effective_price, 100);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE entity_type = 'catalog_discount'").get().count, 5);
  assert.ok(db.sqlite.prepare('SELECT revision FROM catalog_cache_state WHERE id = 1').get().revision >= 6);

  const customerResponse = await listDiscounts(adminContext(db, '/api/admin/discounts', {
    email: 'customer@example.test',
  }));
  assert.equal(customerResponse.status, 403);
});

test('scheduled preview evaluates overlapping campaigns at the proposed start time', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const endingAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const startsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const endsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

  const endingResponse = await createDiscount(adminContext(db, '/api/admin/discounts', {
    method: 'POST',
    body: discountBody({
      name: 'Se termină înainte',
      percentage: 30,
      endsAt: endingAt,
      categoryIds: [],
      brands: [],
      productIds: [4],
    }),
  }));
  assert.equal(endingResponse.status, 201);

  const previewResponse = await previewDiscount(adminContext(db, '/api/admin/discounts/preview', {
    method: 'POST',
    body: discountBody({
      name: 'Reducere programată',
      percentage: 20,
      startsAt,
      endsAt,
      categoryIds: [],
      brands: [],
      productIds: [4],
    }),
  }));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.evaluatedAt, startsAt);
  assert.equal(preview.appliesAtEvaluation, true);
  assert.deepEqual(
    { currentPrice: preview.sample[0].currentPrice, previewPrice: preview.sample[0].previewPrice },
    { currentPrice: 1750, previewPrice: 2000 },
  );
});

test('campaign price is identical in storefront, promo calculation, free delivery and checkout guard', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const createResponse = await createDiscount(adminContext(db, '/api/admin/discounts', {
    method: 'POST',
    email: 'admin@example.test',
    body: discountBody({ name: 'Prag livrare', percentage: 10, categoryIds: [], brands: [], productIds: [4] }),
  }));
  assert.equal(createResponse.status, 201);

  db.sqlite.prepare(`
    INSERT INTO promo_codes (
      id, code, discount_type, discount_value, min_order_amount, is_active, admin_revision
    ) VALUES ('promo-after-campaign', 'AFTER100', 'fixed', 100, 0, 1, 'promo:1')
  `).run();

  const publicResponse = await listProducts({
    env: { DB: db },
    request: new Request('https://shop.example/api/products?brand=Brand%20D'),
  });
  assert.equal(publicResponse.status, 200);
  const item = (await publicResponse.json()).items[0];
  assert.equal(item.price, 2250);
  assert.equal(item.old, 2500);
  assert.equal(item.promo, true);

  const orderResponse = await createOrder(orderContext(db, {
    items: [{ productKey: 'DISC-THRESHOLD', quantity: 1 }],
    customer: {
      name: 'Ana Discount', phone: '+37368000000', city: 'Chișinău', address: 'Strada Test 1',
    },
    delivery: 'courier', payment: 'cash', lang: 'ro', promoCode: 'AFTER100',
  }));
  assert.equal(orderResponse.status, 201);
  const order = (await orderResponse.json()).order;
  assert.equal(order.catalogDiscount, 250);
  assert.equal(order.deliveryFee, 0);
  assert.equal(order.promoDiscount, 100);
  assert.equal(order.total, 2150);
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT unit_price, list_price, line_total FROM order_items WHERE order_id = ?').get(order.id) },
    { unit_price: 2250, list_price: 2500, line_total: 2250 },
  );
  assert.equal(db.sqlite.prepare('SELECT price, source_type, admin_revision FROM products WHERE id = 4').get().price, 2500);
});
