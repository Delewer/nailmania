import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';
import { loadStorefrontCatalog } from '../src/catalog-api.js';
import { onRequestGet as listProducts } from '../functions/api/products/index.js';
import { onRequestGet as getProduct } from '../functions/api/products/[key].js';
import { onRequestGet as getAvailability } from '../functions/api/products/[id]/availability.js';
import { onRequestGet as listCategories } from '../functions/api/categories.js';
import { fullSchema } from './helpers/full-schema.mjs';

const schema = fullSchema;

test('the public D1 product and category routes satisfy the storefront contract', async (t) => {
  const db = new SqliteD1(schema);
  t.after(() => db.close());
  db.sqlite.exec(`
    INSERT INTO categories (id, slug, name_ro, name_ru, sort_order)
    VALUES ('baze', 'baze', 'Baze', 'Базы', 2);
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, brand, name_ro, name_ru,
      price, old_price, specs_json, is_promo
    ) VALUES (
      1, 'T0001', 'SKU-DIRECT', 'baza-rubber', 'baze', 'Nail Mania', 'Bază rubber', 'Каучуковая база',
      120, 140, '[{"label":"Cantitate","value":"15 ml"}]', 1
    );
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved)
    VALUES (1, 1, 4, 1);
    INSERT INTO product_images (product_id, public_url, sort_order, is_primary)
    VALUES (1, 'https://images.example/T0001.webp', 0, 1);
  `);

  const fetchImpl = async (path) => {
    const url = new URL(path, 'https://shop.example');
    if (url.pathname === '/api/products') {
      return listProducts({ request: new Request(url), env: { DB: db } });
    }
    if (url.pathname === '/api/categories') {
      return listCategories({ env: { DB: db } });
    }
    throw new Error(`Unexpected route: ${url}`);
  };

  const snapshot = await loadStorefrontCatalog({ fetchImpl });
  assert.equal(snapshot.categories.length, 1);
  assert.deepEqual(snapshot.categories[0], {
    id: 'baze',
    slug: 'baze',
    name_ro: 'Baze',
    name_ru: 'Базы',
    sort_order: 2,
    seo_title_ro: '',
    seo_title_ru: '',
    seo_description_ro: '',
    seo_description_ru: '',
    product_count: 1,
  });
  assert.equal(snapshot.products.length, 1);
  assert.equal(snapshot.products[0].key, 'T0001');
  assert.equal(snapshot.products[0].stock, 3);
  assert.equal(snapshot.products[0].promo, true);
  assert.equal(snapshot.products[0].image, 'https://images.example/T0001.webp');
  assert.deepEqual(snapshot.products[0].specs, [{ label: 'Cantitate', value: '15 ml' }]);

  const detailResponse = await getProduct({ env: { DB: db }, params: { key: 'sku-direct' } });
  const detail = await detailResponse.json();
  assert.equal(detailResponse.status, 200);
  assert.equal(detail.item.key, 'T0001');
  assert.equal(detail.item.stock, 3);
  assert.equal(detail.item.image, 'https://images.example/T0001.webp');

  const missingResponse = await getProduct({ env: { DB: db }, params: { key: 'missing' } });
  assert.equal(missingResponse.status, 404);
});

test('public catalog filters/sorts by availability and exposes no raw stock counters', async (t) => {
  const db = new SqliteD1(schema);
  t.after(() => db.close());
  db.sqlite.exec(`
    INSERT INTO categories (id, slug, name_ro, name_ru) VALUES ('test', 'test', 'Test', 'Test');
    INSERT INTO products (id, catalog_key, sku, slug, category_id, brand, name_ro, price)
    VALUES
      (1, 'P-IN-LOW', 'P-IN-LOW', 'p-in-low', 'test', 'Brand', 'Produs ieftin', 90),
      (2, 'P-IN-HIGH', 'P-IN-HIGH', 'p-in-high', 'test', 'Brand', 'Produs scump', 190),
      (3, 'P-OUT', 'P-OUT', 'p-out', 'test', 'Brand', 'Produs epuizat', 120);
    INSERT INTO products (id, catalog_key, sku, slug, category_id, brand, name_ro, price, is_active)
    VALUES (4, 'P-INACTIVE', 'P-INACTIVE', 'p-inactive', 'test', 'Brand', 'Produs inactiv', 80, 0);
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved) VALUES
      (1, 1, 3, 1),
      (2, 1, 1, 0),
      (3, 1, 2, 2),
      (4, 1, 10, 0);
  `);

  const inStockResponse = await listProducts({
    request: new Request('https://shop.example/api/products?stock=in&sort=price_desc'),
    env: { DB: db },
  });
  const inStock = await inStockResponse.json();
  assert.equal(inStockResponse.status, 200);
  assert.deepEqual(inStock.items.map((item) => item.key), ['P-IN-HIGH', 'P-IN-LOW']);
  assert.equal(inStock.pagination.total, 2);

  const outResponse = await listProducts({
    request: new Request('https://shop.example/api/products?stock=out&sort=name_asc'),
    env: { DB: db },
  });
  assert.deepEqual((await outResponse.json()).items.map((item) => item.key), ['P-OUT']);

  const availabilityResponse = await getAvailability({
    request: new Request('https://shop.example/api/products/P-IN-LOW/availability'),
    params: { id: 'P-IN-LOW' },
    env: { DB: db },
  });
  const availability = await availabilityResponse.json();
  assert.deepEqual(
    {
      productKey: availability.availability.productKey,
      available: availability.availability.available,
      inStock: availability.availability.inStock,
    },
    { productKey: 'P-IN-LOW', available: 2, inStock: true },
  );
  assert.equal(Object.hasOwn(availability.availability, 'onHand'), false);
  assert.equal(Object.hasOwn(availability.availability, 'reserved'), false);

  const inactiveAvailability = await getAvailability({
    request: new Request('https://shop.example/api/products/P-INACTIVE/availability'),
    params: { id: 'P-INACTIVE' },
    env: { DB: db },
  });
  assert.equal(inactiveAvailability.status, 404);

  const invalidSort = await listProducts({
    request: new Request('https://shop.example/api/products?sort=sql-injection'),
    env: { DB: db },
  });
  assert.equal(invalidSort.status, 400);
  assert.equal((await invalidSort.json()).error.code, 'INVALID_PRODUCT_SORT');

  const invalidPaging = await listProducts({
    request: new Request('https://shop.example/api/products?limit=not-a-number&offset=not-a-number'),
    env: { DB: db },
  });
  assert.equal(invalidPaging.status, 200);
  assert.deepEqual((await invalidPaging.json()).pagination, { limit: 5000, offset: 0, total: 3 });
});
