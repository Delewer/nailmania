import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';
import { cachedCatalogResponse, catalogRevisionBump } from '../functions/_lib/catalog-cache.js';
import { onRequestGet as productPage } from '../functions/product/[key].js';
import { onRequestGet as categoryPage } from '../functions/category/[key].js';
import { onRequestGet as brandPage } from '../functions/brand/[name].js';
import { onRequestGet as sitemap } from '../functions/sitemap.xml.js';
import { fullSchema } from './helpers/full-schema.mjs';

const schema = fullSchema;

const spaShell = `<!doctype html><html lang="ro"><head><!-- SEO:START --><title>Static fallback</title><!-- SEO:END --></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`;

class MemoryCache {
  constructor() { this.entries = new Map(); }
  async match(request) {
    const response = this.entries.get(request.url);
    return response?.clone();
  }
  async put(request, response) {
    this.entries.set(request.url, response.clone());
  }
}

function fixture() {
  const db = new SqliteD1(schema);
  db.sqlite.exec(`
    INSERT INTO categories (
      id, slug, name_ro, name_ru, sort_order, seo_title_ro, seo_description_ro
    ) VALUES (
      'baze', 'baze', 'Baze profesionale', 'Baze', 1,
      'Baze din D1 | Nail Mania', 'Descriere categorie din D1.'
    );
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, brand, name_ro, name_ru,
      description_ro, price, old_price, is_featured
    ) VALUES (
      1, 'PRODUCT-SEO-KEY', 'SKU-SEO-1', 'baza-seo', 'baze', 'Brand D1',
      'Baza server D1', 'Baza server D1', 'Descriere produs din D1.', 149, 179, 1
    );
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved)
    VALUES (1, 1, 3, 1);
    INSERT INTO product_images (product_id, public_url, sort_order, is_primary)
    VALUES (1, '/api/media/sku-seo.webp', 0, 1);

    INSERT INTO categories (id, slug, name_ro, name_ru, sort_order, is_active)
    VALUES ('hidden', 'hidden', 'Hidden', 'Hidden', 2, 0);
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, brand, name_ro, name_ru, price, is_active
    ) VALUES (2, 'HIDDEN-1', 'HIDDEN-1', 'hidden-product', 'hidden', 'Hidden', 'Hidden product', 'Hidden product', 50, 1);
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved) VALUES (2, 1, 2, 0);
  `);
  return db;
}

const assets = (counter) => ({
  async fetch(request) {
    counter.count += 1;
    assert.equal(new URL(request.url).pathname, '/spa-shell');
    return new Response(spaShell, { headers: { 'content-type': 'text/html' } });
  },
});

const context = (db, cache, url, params = {}, assetCounter = { count: 0 }) => ({
  request: new Request(url),
  params,
  env: { DB: db, ASSETS: assets(assetCounter), SITE_URL: 'https://shop.example' },
  data: { catalogCache: cache },
  waitUntil(promise) { return promise; },
});

test('catalog cache hits, then a D1 revision bump makes the old global key unreachable', async (t) => {
  const db = fixture();
  t.after(() => db.close());
  const cache = new MemoryCache();
  let builds = 0;
  const requestContext = context(db, cache, 'https://shop.example/api/catalog-check');
  const build = async () => new Response(`generation-${++builds}`);

  const first = await cachedCatalogResponse(requestContext, build);
  assert.equal(await first.text(), 'generation-1');
  assert.equal(first.headers.get('x-catalog-cache'), 'MISS');
  assert.equal(first.headers.get('cache-control'), 'no-store');

  const second = await cachedCatalogResponse(requestContext, build);
  assert.equal(await second.text(), 'generation-1');
  assert.equal(second.headers.get('x-catalog-cache'), 'HIT');
  assert.equal(builds, 1);

  await db.batch([catalogRevisionBump(db)]);
  const third = await cachedCatalogResponse(requestContext, build);
  assert.equal(await third.text(), 'generation-2');
  assert.equal(third.headers.get('x-catalog-cache'), 'MISS');
  assert.equal(third.headers.get('x-catalog-revision'), '2');
  assert.equal(builds, 2);
  assert.equal(cache.entries.size, 2, 'the old edge object may expire naturally but cannot match revision 2');
});

test('direct product, category and brand routes render D1 metadata, JSON-LD and preserve SPA mounting', async (t) => {
  const db = fixture();
  t.after(() => db.close());
  const cache = new MemoryCache();
  const assetCounter = { count: 0 };
  const productContext = context(
    db,
    cache,
    'https://shop.example/product/SKU-SEO-1',
    { key: 'SKU-SEO-1' },
    assetCounter,
  );

  const first = await productPage(productContext);
  const firstHtml = await first.text();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(first.headers.get('x-catalog-cache'), 'MISS');
  assert.match(firstHtml, /<title>Baza server D1 — 149 lei \| Nail Mania<\/title>/);
  assert.match(firstHtml, /"@type":"Product"/);
  assert.match(firstHtml, /https:\/\/schema\.org\/InStock/);
  assert.match(firstHtml, /<main class="seo-static"/);
  assert.match(firstHtml, /<script type="module" src="\/assets\/app\.js"><\/script>/);

  const second = await productPage(productContext);
  assert.equal(second.headers.get('x-catalog-cache'), 'HIT');
  assert.equal(assetCounter.count, 1, 'the D1 HTML query and shell fetch are skipped on an edge hit');

  await db.batch([
    db.prepare('UPDATE inventory SET on_hand = 1, reserved = 1 WHERE product_id = 1 AND warehouse_id = 1'),
    catalogRevisionBump(db),
  ]);
  const invalidated = await productPage(productContext);
  const invalidatedHtml = await invalidated.text();
  assert.equal(invalidated.headers.get('x-catalog-cache'), 'MISS');
  assert.equal(invalidated.headers.get('x-catalog-revision'), '2');
  assert.match(invalidatedHtml, /https:\/\/schema\.org\/OutOfStock/);
  assert.equal(assetCounter.count, 2);

  const categoryResponse = await categoryPage(context(
    db,
    cache,
    'https://shop.example/category/baze',
    { key: 'baze' },
    assetCounter,
  ));
  const categoryHtml = await categoryResponse.text();
  assert.equal(categoryResponse.status, 200);
  assert.match(categoryHtml, /<title>Baze din D1 \| Nail Mania<\/title>/);
  assert.match(categoryHtml, /"@type":"CollectionPage"/);
  assert.match(categoryHtml, /\/product\/PRODUCT-SEO-KEY/);

  const brandResponse = await brandPage(context(
    db,
    cache,
    'https://shop.example/brand/Brand%20D1',
    { name: 'Brand%20D1' },
    assetCounter,
  ));
  const brandHtml = await brandResponse.text();
  assert.equal(brandResponse.status, 200);
  assert.match(brandHtml, /<title>Brand D1 — produse profesionale \| Nail Mania<\/title>/);
  assert.match(brandHtml, /<link rel="canonical" href="https:\/\/shop\.example\/brand\/Brand%20D1"/);
  assert.match(brandHtml, /"@type":"CollectionPage"/);
  assert.match(brandHtml, /\/product\/PRODUCT-SEO-KEY/);

  const missingBrand = await brandPage(context(
    db,
    cache,
    'https://shop.example/brand/Missing',
    { name: 'Missing' },
    assetCounter,
  ));
  const missingBrandHtml = await missingBrand.text();
  assert.equal(missingBrand.status, 404);
  assert.match(missingBrandHtml, /<title>Brand negăsit \| Nail Mania<\/title>/);
  assert.match(missingBrandHtml, /content="noindex,follow"/);
});

test('D1 sitemap contains active canonical product/category URLs and excludes inactive catalog rows', async (t) => {
  const db = fixture();
  t.after(() => db.close());
  const response = await sitemap(context(db, new MemoryCache(), 'https://shop.example/sitemap.xml'));
  const xml = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.match(xml, /https:\/\/shop\.example\/category\/baze</);
  assert.match(xml, /https:\/\/shop\.example\/product\/PRODUCT-SEO-KEY</);
  assert.match(xml, /https:\/\/shop\.example\/api\/media\/sku-seo\.webp/);
  assert.doesNotMatch(xml, /hidden|HIDDEN-1/i);
});
