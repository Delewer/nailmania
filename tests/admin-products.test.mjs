import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdminProductError,
  normalizeAdminProduct,
  stockAdjustmentPlan,
} from '../functions/_lib/admin-products.js';
import { onRequestPost as createProduct } from '../functions/api/admin/products/index.js';
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
    { revision: created.revision, price: 110, nameRo: 'Produs actualizat' },
    { id: String(created.id) },
  ));
  assert.equal(updateResponse.status, 200);
  const updated = (await updateResponse.json()).product;
  assert.equal(updated.price, 110);
  assert.equal(updated.nameRo, 'Produs actualizat');
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
