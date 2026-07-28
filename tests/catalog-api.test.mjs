import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CatalogApiError,
  loadStorefrontCatalog,
} from '../src/catalog-api.js';

const category = {
  id: 'baze',
  slug: 'baze',
  name_ro: 'Baze',
  name_ru: 'Базы',
  sort_order: 0,
  seo_title_ro: '',
  seo_title_ru: '',
  seo_description_ro: '',
  seo_description_ru: '',
  product_count: 1,
};
const product = {
  id: 1,
  key: 'T0001',
  code: 'T0001',
  cat: 'baze',
  brand: 'Nail Mania',
  name: 'Bază rubber',
  nameRu: 'Каучуковая база',
  price: 120,
  old: 140,
  stock: 3,
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

const fetchFor = ({ products = [product], categories = [category] } = {}) => async (url) => {
  if (String(url).startsWith('/api/products')) return jsonResponse({ ok: true, items: products });
  if (url === '/api/categories') return jsonResponse({ ok: true, items: categories });
  throw new Error(`Unexpected URL: ${url}`);
};

test('loads and validates products and categories from their D1 API routes', async () => {
  const snapshot = await loadStorefrontCatalog({ fetchImpl: fetchFor() });
  assert.deepEqual(snapshot.products, [product]);
  assert.deepEqual(snapshot.categories, [category]);
});

test('reports API unavailability without requesting a static fallback', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (String(url).startsWith('/api/products')) throw new TypeError('network down');
    return jsonResponse({ ok: true, items: [category] });
  };

  await assert.rejects(
    loadStorefrontCatalog({ fetchImpl }),
    (error) => error instanceof CatalogApiError && error.code === 'CATALOG_API_UNAVAILABLE',
  );
  assert.equal(calls.length, 2);
  assert.equal(calls.some((url) => String(url).includes('catalog.json')), false);
});

test('treats a non-success API response as unavailable', async () => {
  const fetchImpl = async (url) => String(url).startsWith('/api/products')
    ? jsonResponse({ ok: false }, 503)
    : jsonResponse({ ok: true, items: [category] });

  await assert.rejects(
    loadStorefrontCatalog({ fetchImpl }),
    (error) => error.code === 'CATALOG_API_UNAVAILABLE' && error.status === 503,
  );
});

test('rejects HTML and malformed collection payloads', async (t) => {
  await t.test('HTML instead of JSON', async () => {
    const fetchImpl = async (url) => String(url).startsWith('/api/products')
      ? new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
      : jsonResponse({ ok: true, items: [category] });
    await assert.rejects(
      loadStorefrontCatalog({ fetchImpl }),
      (error) => error.code === 'CATALOG_API_INVALID_RESPONSE',
    );
  });

  await t.test('missing items array', async () => {
    const fetchImpl = async (url) => String(url).startsWith('/api/products')
      ? jsonResponse({ ok: true })
      : jsonResponse({ ok: true, items: [category] });
    await assert.rejects(
      loadStorefrontCatalog({ fetchImpl }),
      (error) => error.code === 'CATALOG_API_INVALID_RESPONSE',
    );
  });
});

test('rejects duplicate keys and products that reference unknown categories', async (t) => {
  await t.test('duplicate product key', async () => {
    await assert.rejects(
      loadStorefrontCatalog({ fetchImpl: fetchFor({ products: [product, { ...product }] }) }),
      (error) => error.code === 'CATALOG_API_INVALID_RESPONSE' && /Duplicate product key/.test(error.message),
    );
  });

  await t.test('unknown category', async () => {
    await assert.rejects(
      loadStorefrontCatalog({ fetchImpl: fetchFor({ products: [{ ...product, cat: 'missing' }] }) }),
      (error) => error.code === 'CATALOG_API_INVALID_RESPONSE' && /unknown category/.test(error.message),
    );
  });
});
