import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as importProducts } from '../functions/api/admin/products/import.js';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';
import { fullSchema } from './helpers/full-schema.mjs';

function setup(role = 'manager') {
  const db = new SqliteD1(fullSchema);
  db.sqlite.exec(`
    INSERT INTO categories (id, slug, name_ro, name_ru)
    VALUES ('alungire', 'alungire', 'Alungire', 'Наращивание');
    INSERT INTO users (id, email, name, role, status)
    VALUES ('manager-1', 'manager@example.test', 'Catalog Manager', '${role}', 'active');
  `);
  return db;
}

function context(db, items) {
  return {
    env: {
      DB: db,
      ENVIRONMENT: 'local',
      ADMIN_DEV_TOKEN: 'test-secret',
      ADMIN_DEV_EMAIL: 'manager@example.test',
    },
    request: new Request('http://127.0.0.1:8788/api/admin/products/import', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        origin: 'http://127.0.0.1:8788',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        importId: '22222222-2222-4222-8222-222222222222',
        sourceFile: 'gellichidxls.xls',
        items,
      }),
    }),
  };
}

const importedItem = (overrides = {}) => ({
  sheetRow: 4,
  sku: '3407',
  categoryId: 'alungire',
  brand: 'Valeri',
  nameRo: 'Valeri Builder Gel 15ml №01',
  price: 145,
  isActive: true,
  specs: [{ label: 'Cantitate', value: '15 ml' }],
  ...overrides,
});

test('manager Excel import creates and updates products without touching purchase price, stock or media', async (t) => {
  const db = setup();
  t.after(() => db.close());
  db.sqlite.exec(`
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, brand, name_ro, name_ru,
      description_ro, description_ru, price, old_price, cost_price, specs_json,
      is_active, is_featured, is_new, is_promo, is_summer, low_stock_threshold,
      source_type, admin_revision
    ) VALUES (
      1, '3407', '3407', '3407', 'alungire', 'Old Brand', 'Nume vechi', 'Старое имя',
      'Descriere păstrată', 'Описание сохранено', 120, 160, 83, '[{"label":"Culoare","value":"Roz"}]',
      1, 1, 1, 1, 1, 7, 'admin', 'product:before'
    );
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, admin_revision)
    VALUES (1, 1, 9, 2, 'inventory:before');
    INSERT INTO product_images (product_id, object_key, public_url, alt_ro, alt_ru, sort_order, is_primary)
    VALUES (1, 'products/3407.webp', 'https://example.test/3407.webp', 'Imagine', 'Изображение', 0, 1);
  `);

  const response = await importProducts(context(db, [
    importedItem(),
    importedItem({ sheetRow: 5, sku: '3500', nameRo: 'DNKa Liquid Acrygel 12ml', brand: "DNK'a", price: 180, specs: [{ label: 'Cantitate', value: '12 ml' }] }),
  ]));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.counts, { created: 1, updated: 1, unchanged: 0, failed: 0 });
  const existing = db.sqlite.prepare('SELECT * FROM products WHERE id = 1').get();
  assert.equal(existing.name_ro, 'Valeri Builder Gel 15ml №01');
  assert.equal(existing.name_ru, 'Старое имя');
  assert.equal(existing.price, 145);
  assert.equal(existing.old_price, 160);
  assert.equal(existing.cost_price, 83);
  assert.equal(existing.description_ro, 'Descriere păstrată');
  assert.equal(existing.description_ru, 'Описание сохранено');
  assert.equal(existing.specs_json, '[{"label":"Culoare","value":"Roz"}]');
  assert.equal(existing.is_featured, 1);
  assert.equal(existing.is_new, 1);
  assert.equal(existing.is_promo, 1);
  assert.equal(existing.is_summer, 1);
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = 1').get() },
    { on_hand: 9, reserved: 2 },
  );
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM product_images WHERE product_id = 1').get().count, 1);

  const created = db.sqlite.prepare("SELECT * FROM products WHERE sku = '3500'").get();
  assert.equal(created.cost_price, null);
  assert.equal(created.name_ru, 'DNKa Liquid Acrygel 12ml');
  assert.equal(created.description_ro, '');
  assert.equal(created.specs_json, '[{"label":"Cantitate","value":"12 ml"}]');
  assert.deepEqual(
    { ...db.sqlite.prepare('SELECT on_hand, reserved FROM inventory WHERE product_id = ?').get(created.id) },
    { on_hand: 0, reserved: 0 },
  );
  assert.deepEqual(
    db.sqlite.prepare('SELECT action FROM admin_audit_log ORDER BY action').all().map((row) => row.action),
    ['product.import_create', 'product.import_update'],
  );
});

test('Excel import rejects unavailable category mappings before writing products', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const response = await importProducts(context(db, [importedItem({ categoryId: 'missing' })]));
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.error.code, 'CATEGORY_NOT_FOUND');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM products').get().count, 0);
});
