import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdminProductError,
  getAdminProduct,
  normalizeAdminProduct,
  stockAdjustmentPlan,
} from '../functions/_lib/admin-products.js';
import {
  onRequestGet as listProducts,
  onRequestPost as createProduct,
} from '../functions/api/admin/products/index.js';
import {
  onRequestDelete as deleteProduct,
  onRequestPatch as updateProduct,
} from '../functions/api/admin/products/[id].js';
import { onRequestPost as adjustInventory } from '../functions/api/admin/products/[id]/inventory.js';
import { onRequestPost as uploadImage } from '../functions/api/admin/uploads.js';
import { onRequestDelete as discardImage } from '../functions/api/admin/uploads/[key].js';
import { transitionOrder } from '../functions/_lib/order-lifecycle.js';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';
import { fullSchema } from './helpers/full-schema.mjs';

const schema = fullSchema;

function setup() {
  const db = new SqliteD1(schema);
  db.sqlite.prepare(`
    INSERT INTO categories (id, slug, name_ro, name_ru)
    VALUES ('test', 'test', 'Test', 'Тест')
  `).run();
  db.sqlite.prepare(`
    INSERT INTO users (id, email, name, role, status)
    VALUES ('admin-1', 'admin@example.test', 'Test Administrator', 'admin', 'active')
  `).run();
  return db;
}

const env = (db, extra = {}) => ({
  DB: db,
  ENVIRONMENT: 'local',
  ADMIN_DEV_TOKEN: 'test-secret',
  ADMIN_DEV_EMAIL: 'admin@example.test',
  ...extra,
});

function jsonContext(db, path, method, body, params = {}) {
  return {
    env: env(db),
    params,
    request: new Request(`http://127.0.0.1:8788${path}`, {
      method,
      headers: {
        authorization: 'Bearer test-secret',
        origin: 'http://127.0.0.1:8788',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  };
}

class BeforeFirstBatchD1 {
  constructor(db, beforeBatch) {
    this.db = db;
    this.beforeBatch = beforeBatch;
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  withSession() {
    return this;
  }

  async batch(statements) {
    const beforeBatch = this.beforeBatch;
    this.beforeBatch = null;
    if (beforeBatch) await beforeBatch();
    return this.db.batch(statements);
  }
}

class RecordingD1 {
  constructor(db) {
    this.db = db;
    this.queries = [];
  }

  prepare(sql) {
    this.queries.push(sql);
    return this.db.prepare(sql);
  }

  withSession() {
    return this;
  }

  batch(statements) {
    return this.db.batch(statements);
  }
}

function insertProductAndOrder(db, options) {
  const productId = 1;
  const orderId = `order-${options.status}`;
  const revision = `inventory:${options.status}:initial`;
  db.sqlite.prepare(`
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, name_ro, name_ru,
      price, source_type, admin_revision
    ) VALUES (?, 'RACE-001', 'RACE-001', 'race-001', 'test',
              'Produs concurent', 'Concurrent product', 100, 'admin', 'product:initial')
  `).run(productId);
  db.sqlite.prepare(`
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, admin_revision)
    VALUES (?, 1, ?, ?, ?)
  `).run(productId, options.onHand, options.reserved, revision);
  db.sqlite.prepare(`
    INSERT INTO orders (
      id, order_no, status, language, customer_name, customer_phone,
      delivery_method, delivery_label, payment_method, payment_label,
      items_subtotal, catalog_discount, promo_discount, total_amount
    ) VALUES (?, ?, ?, 'ro', 'Test Client', '+37360000000',
              'pickup', 'Pickup', 'cash', 'Cash', 200, 0, 0, 200)
  `).run(orderId, `NM-${options.status}`, options.status);
  db.sqlite.prepare(`
    INSERT INTO order_items (
      order_id, product_id, product_key, sku, name,
      unit_price, list_price, quantity, sold_quantity, line_total
    ) VALUES (?, ?, 'RACE-001', 'RACE-001', 'Produs concurent', 100, 100, 2, ?, 200)
  `).run(orderId, productId, options.status === 'completed' ? 2 : 0);
  return { productId, orderId, revision };
}

const draft = (overrides = {}) => ({
  sku: 'ADMIN-T001',
  categoryId: 'test',
  brand: 'Test Brand',
  nameRo: 'Produs administrativ',
  nameRu: 'Административный товар',
  descriptionRo: 'Descriere',
  descriptionRu: 'Описание',
  price: 100,
  oldPrice: 120,
  costPrice: 50,
  lowStockThreshold: 2,
  initialStock: 4,
  specs: [{ label: 'Volum', value: '10 ml' }],
  images: [{ url: 'https://example.test/product.webp' }],
  isActive: true,
  isNew: true,
  ...overrides,
});

test('normalizes product input and rejects an invalid old price', () => {
  const product = normalizeAdminProduct(draft());
  assert.equal(product.catalogKey, 'ADMIN-T001');
  assert.equal(product.initialStock, 4);
  assert.deepEqual(product.specs, [{ label: 'Volum', value: '10 ml' }]);
  assert.throws(
    () => normalizeAdminProduct(draft({ price: 100, oldPrice: 90 })),
    (error) => error instanceof AdminProductError && error.code === 'INVALID_OLD_PRICE',
  );
});

test('admin product snapshot replaces repeated search, count and summary queries', async (t) => {
  const db = setup();
  const recordingDb = new RecordingD1(db);
  t.after(() => db.close());
  db.sqlite.exec(`
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, name_ro, name_ru,
      price, source_type, admin_revision
    ) VALUES (1, 'LIST-001', 'LIST-001', 'list-001', 'test',
              'Produs listat', 'Listed product', 100, 'admin', 'product:initial');
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, admin_revision)
    VALUES (1, 1, 2, 0, 'inventory:initial');
  `);
  const response = await listProducts({
    env: env(recordingDb),
    request: new Request('http://127.0.0.1:8788/api/admin/products?snapshot=1', {
      headers: { authorization: 'Bearer test-secret' },
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.items.length, 1);
  assert.equal(Object.hasOwn(payload, 'counts'), false);
  assert.equal(recordingDb.queries.some((sql) => sql.includes('AS out_of_stock')), false);
  assert.equal(recordingDb.queries.some((sql) => /SELECT\s+COUNT\(\*\)\s+AS count\s+FROM products/i.test(sql)), false);
});

test('admin product detail uses an indexed identity predicate', async (t) => {
  const db = setup();
  const recordingDb = new RecordingD1(db);
  t.after(() => db.close());
  db.sqlite.exec(`
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, name_ro, name_ru,
      price, source_type, admin_revision
    ) VALUES (1, 'DETAIL-001', 'DETAIL-001', 'detail-001', 'test',
              'Produs detaliat', 'Detailed product', 100, 'admin', 'product:initial');
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, admin_revision)
    VALUES (1, 1, 2, 0, 'inventory:initial');
  `);

  const product = await getAdminProduct(recordingDb, '1');
  const detailQuery = recordingDb.queries.find((sql) => sql.includes('JOIN product_catalog_prices'));

  assert.equal(product.id, 1);
  assert.match(detailQuery, /WHERE p\.id = \?/);
  assert.doesNotMatch(detailQuery, /CAST\(p\.id AS TEXT\)|\bOR p\.catalog_key\b/);
});

test('case-insensitive SKU conflict checks use the dedicated index', (t) => {
  const db = setup();
  t.after(() => db.close());
  const plan = db.sqlite.prepare(`
    EXPLAIN QUERY PLAN
    SELECT id FROM products
    WHERE id <> ? AND sku = ? COLLATE NOCASE
    LIMIT 1
  `).all(1, 'sku-1');

  assert.match(plan.map((row) => row.detail).join('\n'), /idx_products_sku_nocase/);
});

test('stock plans cannot reduce physical stock below reservations', () => {
  assert.deepEqual(stockAdjustmentPlan(
    { operation: 'receipt', quantity: 3, reason: 'Supplier receipt' },
    { onHand: 5, reserved: 2 },
  ), {
    operation: 'receipt',
    reason: 'Supplier receipt',
    deltaOnHand: 3,
    nextOnHand: 8,
    currentOnHand: 5,
    reserved: 2,
  });
  assert.throws(
    () => stockAdjustmentPlan(
      { operation: 'write_off', quantity: 4, reason: 'Damaged items' },
      { onHand: 5, reserved: 2 },
    ),
    (error) => error instanceof AdminProductError && error.code === 'INSUFFICIENT_UNRESERVED_STOCK',
  );
});

test('a physical sale releases expired cart holds before checking available stock', async (t) => {
  const db = setup();
  t.after(() => db.close());
  db.sqlite.exec(`
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, name_ro, name_ru,
      price, source_type, admin_revision
    ) VALUES (1, 'EXP-001', 'EXP-001', 'exp-001', 'test',
              'Produs expirat', 'Expired product', 100, 'admin', 'product:initial');
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, admin_revision)
    VALUES (1, 1, 1, 1, 'inventory:initial');
    INSERT INTO cart_reservations (
      id, cart_id, product_id, quantity, status, expires_at, created_at, updated_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222', 1, 1, 'ACTIVE',
      '2020-01-01T00:15:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'
    );
  `);

  const response = await adjustInventory(jsonContext(
    db,
    '/api/admin/products/1/inventory',
    'POST',
    { revision: 'inventory:initial', operation: 'write_off', quantity: 1, reason: 'Physical shop sale' },
    { id: '1' },
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = 1').get() },
    { on_hand: 0, reserved: 0 },
  );
  assert.equal(db.sqlite.prepare('SELECT status FROM cart_reservations').get().status, 'EXPIRED');
});

test('admin product lifecycle records metadata, stock movements and audit entries', async (t) => {
  const db = setup();
  t.after(() => db.close());

  const createResponse = await createProduct(jsonContext(db, '/api/admin/products', 'POST', draft()));
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).product;
  assert.equal(created.sourceType, 'admin');
  assert.equal(created.onHand, 4);
  assert.equal(created.movements[0].type, 'opening_balance');

  const updateResponse = await updateProduct(jsonContext(
    db,
    `/api/admin/products/${created.id}`,
    'PATCH',
    { revision: created.revision, price: 110, nameRo: 'Produs actualizat', isFeatured: true },
    { id: String(created.id) },
  ));
  assert.equal(updateResponse.status, 200);
  const updated = (await updateResponse.json()).product;
  assert.equal(updated.price, 110);
  assert.equal(updated.nameRo, 'Produs actualizat');
  assert.equal(updated.isFeatured, true);
  assert.notEqual(updated.revision, created.revision);

  const staleResponse = await updateProduct(jsonContext(
    db,
    `/api/admin/products/${created.id}`,
    'PATCH',
    { revision: created.revision, price: 115 },
    { id: String(created.id) },
  ));
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).error.code, 'PRODUCT_REVISION_CONFLICT');

  const stockResponse = await adjustInventory(jsonContext(
    db,
    `/api/admin/products/${created.id}/inventory`,
    'POST',
    { revision: updated.inventoryRevision, operation: 'receipt', quantity: 3, reason: 'Supplier receipt' },
    { id: String(created.id) },
  ));
  assert.equal(stockResponse.status, 200);
  const stocked = (await stockResponse.json()).product;
  assert.equal(stocked.onHand, 7);
  assert.equal(stocked.movements[0].type, 'receipt');
  assert.equal(stocked.movements[0].deltaOnHand, 3);

  const deleteResponse = await deleteProduct(jsonContext(
    db,
    `/api/admin/products/${created.id}`,
    'DELETE',
    { revision: stocked.revision },
    { id: String(created.id) },
  ));
  assert.equal(deleteResponse.status, 200);
  const deleted = (await deleteResponse.json()).product;
  assert.equal(deleted.isDeleted, true);
  assert.equal(deleted.isActive, false);
  assert.equal(db.sqlite.prepare('SELECT source_type FROM products WHERE id = ?').get(created.id).source_type, 'admin');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM admin_audit_log').get().count, 4);
  assert.equal(db.sqlite.prepare('SELECT revision FROM catalog_cache_state WHERE id = 1').get().revision, 5);
});

test('a concurrent sale invalidates a manual stock adjustment before it can overwrite stock', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const fixture = insertProductAndOrder(db, { status: 'ready', onHand: 5, reserved: 2 });
  let transition;
  const racingDb = new BeforeFirstBatchD1(db, async () => {
    transition = await transitionOrder(db, {
      orderId: fixture.orderId,
      toStatus: 'completed',
      now: '2026-07-16T10:00:00.000Z',
    });
  });

  const response = await adjustInventory(jsonContext(
    racingDb,
    `/api/admin/products/${fixture.productId}/inventory`,
    'POST',
    { revision: fixture.revision, operation: 'receipt', quantity: 3, reason: 'Supplier receipt' },
    { id: String(fixture.productId) },
  ));

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'INVENTORY_REVISION_CONFLICT');
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = ?').get(fixture.productId) },
    { on_hand: 3, reserved: 0 },
  );
  assert.equal(
    db.sqlite.prepare('SELECT admin_revision FROM inventory WHERE product_id = ?').get(fixture.productId).admin_revision,
    `order:${transition.transitionToken}:sale`,
  );
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_movements WHERE movement_type = 'receipt'").get().count, 0);
});

test('a concurrent return invalidates a manual stock adjustment before it can overwrite stock', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const fixture = insertProductAndOrder(db, { status: 'completed', onHand: 3, reserved: 0 });
  let transition;
  const racingDb = new BeforeFirstBatchD1(db, async () => {
    transition = await transitionOrder(db, {
      orderId: fixture.orderId,
      toStatus: 'returned',
      now: '2026-07-16T11:00:00.000Z',
    });
  });

  const response = await adjustInventory(jsonContext(
    racingDb,
    `/api/admin/products/${fixture.productId}/inventory`,
    'POST',
    { revision: fixture.revision, operation: 'receipt', quantity: 3, reason: 'Supplier receipt' },
    { id: String(fixture.productId) },
  ));

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'INVENTORY_REVISION_CONFLICT');
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = ?').get(fixture.productId) },
    { on_hand: 5, reserved: 0 },
  );
  assert.equal(
    db.sqlite.prepare('SELECT admin_revision FROM inventory WHERE product_id = ?').get(fixture.productId).admin_revision,
    `order:${transition.transitionToken}:return`,
  );
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_movements WHERE movement_type = 'receipt'").get().count, 0);
});

class FakeR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, value, options) {
    this.objects.set(key, { value: new Uint8Array(value), options });
  }

  async delete(key) {
    this.objects.delete(key);
  }
}

test('image upload accepts verified image bytes and writes to R2', async (t) => {
  const db = setup();
  const bucket = new FakeR2Bucket();
  t.after(() => db.close());
  const png = new File([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  ], 'product.png', { type: 'image/png' });
  const form = new FormData();
  form.set('file', png);
  const response = await uploadImage({
    env: env(db, { PRODUCT_IMAGES: bucket }),
    request: new Request('http://127.0.0.1:8788/api/admin/uploads', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret', origin: 'http://127.0.0.1:8788' },
      body: form,
    }),
  });

  assert.equal(response.status, 201);
  const image = (await response.json()).image;
  assert.match(image.objectKey, /^admin-\d{8}-[a-f0-9-]+\.png$/);
  assert.equal(bucket.objects.has(image.objectKey), true);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE action = 'image.upload'").get().count, 1);

  db.sqlite.prepare("UPDATE categories SET image_url = ?, image_object_key = ? WHERE id = 'test'")
    .run(image.url, image.objectKey);
  const referencedResponse = await discardImage({
    env: env(db, { PRODUCT_IMAGES: bucket }),
    params: { key: image.objectKey },
    request: new Request(`http://127.0.0.1:8788/api/admin/uploads/${image.objectKey}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer test-secret', origin: 'http://127.0.0.1:8788' },
    }),
  });
  assert.equal(referencedResponse.status, 409);
  assert.equal((await referencedResponse.json()).error.code, 'IMAGE_IN_USE');
  assert.equal(bucket.objects.has(image.objectKey), true);
  db.sqlite.prepare("UPDATE categories SET image_url = '', image_object_key = '' WHERE id = 'test'").run();

  const deleteResponse = await discardImage({
    env: env(db, { PRODUCT_IMAGES: bucket }),
    params: { key: image.objectKey },
    request: new Request(`http://127.0.0.1:8788/api/admin/uploads/${image.objectKey}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer test-secret', origin: 'http://127.0.0.1:8788' },
    }),
  });
  assert.equal(deleteResponse.status, 200);
  assert.equal(bucket.objects.has(image.objectKey), false);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE action = 'image.delete'").get().count, 1);
  assert.equal(db.sqlite.prepare('SELECT revision FROM catalog_cache_state WHERE id = 1').get().revision, 3);
});
