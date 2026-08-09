import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';
import {
  normalizeProductEvent,
  prepareProductDataPoint,
  PRODUCT_EVENT_LAYOUT,
} from '../functions/_lib/product-events.js';
import { onRequestPost as eventsEndpoint } from '../functions/api/events.js';
import {
  analyticsMetricsSql,
  analyticsReaderConfig,
  readAnalyticsMetrics,
} from '../functions/_lib/analytics-reader.js';
import { rateLimitRule } from '../functions/_lib/rate-limit.js';
import {
  analyticsAnonymousId,
  buildClientProductEvent,
  trackProductEvent,
} from '../src/product-analytics.js';
import { fullSchema } from './helpers/full-schema.mjs';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

function setup() {
  const db = new SqliteD1(fullSchema);
  db.sqlite.exec(`
    INSERT INTO categories (id, slug, name_ro) VALUES ('gellac', 'gellac', 'Gel lac');
    INSERT INTO products (id, catalog_key, sku, slug, category_id, brand, name_ro, price)
    VALUES (1, 'P-1', 'P-1', 'p-1', 'gellac', 'Brand sigur', 'Produs', 125);
  `);
  return db;
}

test('event schema is strict and search never accepts the raw query or PII fields', () => {
  assert.deepEqual(normalizeProductEvent({
    event: 'search',
    anonymousId: UUID,
    language: 'ro',
    source: 'search',
    resultCount: 12,
    queryLength: 8,
  }), {
    event: 'search',
    anonymousId: UUID,
    language: 'ro',
    source: 'search',
    productKey: '',
    quantity: 0,
    itemCount: 0,
    value: 0,
    resultCount: 12,
    queryLength: 8,
  });
  assert.throws(() => normalizeProductEvent({
    event: 'search', anonymousId: UUID, language: 'ro', source: 'search',
    resultCount: 1, queryLength: 3, query: 'ana@example.test',
  }), (error) => error.code === 'INVALID_EVENT_FIELD');
  assert.throws(() => normalizeProductEvent({
    event: 'product_view', anonymousId: '060000000', language: 'ro', source: 'product_page', productKey: 'P-1',
  }), (error) => error.code === 'INVALID_ANONYMOUS_ID');
});

test('client uses a stable anonymous UUID, never sends search text and cannot emit order_created', async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || '',
    setItem: (key, value) => values.set(key, value),
  };
  const cryptoObject = { randomUUID: () => UUID };
  assert.equal(analyticsAnonymousId(storage, cryptoObject), UUID);
  assert.equal(analyticsAnonymousId(storage, { randomUUID: () => 'different' }), UUID);
  assert.deepEqual(buildClientProductEvent('search', {
    language: 'ro', source: 'search', resultCount: 3, queryLength: 17,
  }, { storage, crypto: cryptoObject }), {
    event: 'search', anonymousId: UUID, language: 'ro', source: 'search',
    resultCount: 3, queryLength: 17,
  });
  assert.throws(() => buildClientProductEvent('order_created', {}, { storage, crypto: cryptoObject }));

  let beacon;
  const accepted = trackProductEvent('product_view', {
    language: 'ru', source: 'product_page', productKey: 'P-1',
  }, {
    storage,
    crypto: cryptoObject,
    navigator: { sendBeacon: (url, body) => { beacon = { url, body }; return true; } },
  });
  assert.equal(accepted, true);
  assert.equal(beacon.url, '/api/events');
  assert.equal(beacon.body.type, 'application/json');
  assert.deepEqual(JSON.parse(await beacon.body.text()), {
    event: 'product_view', anonymousId: UUID, language: 'ru', source: 'product_page', productKey: 'P-1',
  });

  let fallback;
  trackProductEvent('checkout_started', {
    language: 'ro', source: 'checkout', itemCount: 2, value: 300,
  }, {
    storage,
    crypto: cryptoObject,
    navigator: {},
    fetch: async (url, options) => { fallback = { url, options }; return new Response(null, { status: 202 }); },
  });
  await Promise.resolve();
  assert.equal(fallback.url, '/api/events');
  assert.equal(fallback.options.keepalive, true);
  assert.equal(fallback.options.credentials, 'same-origin');
});

test('Analytics Engine point uses catalog-owned dimensions and one anonymous <=96-byte index', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const { point } = await prepareProductDataPoint({
    db,
    env: { ANALYTICS_INDEX_SECRET: 'test-analytics-secret-32-bytes' },
    input: {
      event: 'add_to_cart', anonymousId: UUID, language: 'ru',
      source: 'product_card', productKey: 'P-1', quantity: 2,
    },
    now: new Date('2026-07-16T12:00:00.000Z'),
  });
  assert.deepEqual(PRODUCT_EVENT_LAYOUT.blobs, ['event', 'product_key', 'category_id', 'brand', 'language', 'source']);
  assert.deepEqual(point.blobs, ['add_to_cart', 'P-1', 'gellac', 'Brand sigur', 'ru', 'product_card']);
  assert.deepEqual(point.doubles, [1, 2, 250, 0, 0]);
  assert.equal(point.indexes.length, 1);
  assert.equal(new TextEncoder().encode(point.indexes[0]).byteLength, 64);
  assert.ok(!JSON.stringify(point).includes(UUID));
});

function postEvent(db, body, options = {}) {
  const origin = options.origin === undefined ? 'https://shop.test' : options.origin;
  const headers = new Headers({ 'content-type': 'application/json' });
  if (origin) headers.set('origin', origin);
  if (options.fetchSite) headers.set('sec-fetch-site', options.fetchSite);
  return eventsEndpoint({
    request: new Request('https://shop.test/api/events', {
      method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env: { DB: db, ENVIRONMENT: options.environment || 'production', ...options.env },
  });
}

test('public event endpoint is same-origin, size-bounded and cannot forge order_created', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const valid = {
    event: 'product_view', anonymousId: UUID, language: 'ro',
    source: 'product_page', productKey: 'P-1',
  };

  const local = await postEvent(db, valid, { environment: 'local', origin: null });
  assert.equal(local.status, 202);
  assert.deepEqual(await local.json(), {
    ok: true, configured: true, recorded: true, event: 'product_view',
  });
  assert.deepEqual({ ...db.sqlite.prepare(`
    SELECT event_type, event_count, quantity_or_items, value_lei
    FROM product_event_daily
  `).get() }, {
    event_type: 'product_view', event_count: 1, quantity_or_items: 0, value_lei: 0,
  });

  const missingOrigin = await postEvent(db, valid, { origin: null });
  assert.equal(missingOrigin.status, 403);
  const crossOrigin = await postEvent(db, valid, { origin: 'https://evil.test', fetchSite: 'cross-site' });
  assert.equal(crossOrigin.status, 403);

  const forged = await postEvent(db, {
    event: 'order_created', anonymousId: UUID, language: 'ro', source: 'checkout', itemCount: 1, value: 999999,
  });
  assert.equal(forged.status, 403);
  assert.equal((await forged.json()).error.code, 'SERVER_EVENT_ONLY');

  const oversized = await postEvent(db, JSON.stringify({ ...valid, padding: 'x'.repeat(5000) }));
  assert.equal(oversized.status, 413);

  const rule = rateLimitRule(new Request('https://shop.test/api/events', { method: 'POST' }));
  assert.deepEqual({ scope: rule.scope, limit: rule.limit, windowSeconds: rule.windowSeconds }, {
    scope: 'analytics.events', limit: 120, windowSeconds: 600,
  });
});

test('Analytics SQL reader is optional, template-only and weights sampled rows', async () => {
  assert.deepEqual(analyticsReaderConfig({}), { configured: false });
  assert.deepEqual(analyticsReaderConfig({ CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }), { configured: false });
  assert.throws(() => analyticsReaderConfig({
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    ANALYTICS_READ_TOKEN: 'secret',
    PRODUCT_ANALYTICS_DATASET: 'bad-name;DROP',
  }), (error) => error.code === 'ANALYTICS_READER_INVALID_CONFIG');

  const range = { from: '2026-07-10T00:00:00.000Z', to: '2026-07-17T00:00:00.000Z' };
  const sql = analyticsMetricsSql('nailmania_product_events_preview', range);
  assert.match(sql, /SUM\(_sample_interval\) AS events/);
  assert.match(sql, /SUM\(_sample_interval \* double3\) AS value_lei/);
  assert.match(sql, /2026-07-10 00:00:00/);
  assert.match(sql, /ORDER BY event/);
  assert.doesNotMatch(sql, /ORDER BY blob1/);
  assert.doesNotMatch(sql, /\.000Z/);

  let request;
  const result = await readAnalyticsMetrics({
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    ANALYTICS_READ_TOKEN: 'reader-secret',
    PRODUCT_ANALYTICS_DATASET: 'nailmania_product_events_preview',
  }, range, {
    signal: new AbortController().signal,
    fetch: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ data: [
        { event: 'product_view', events: 200, quantity_or_items: 0, value_lei: 0, result_count: 0 },
        { event: 'add_to_cart', events: 40, quantity_or_items: 55, value_lei: 5000, result_count: 0 },
        { event: 'search', events: 25, quantity_or_items: 0, value_lei: 0, result_count: 300 },
        { event: 'checkout_started', events: 20, quantity_or_items: 30, value_lei: 4000, result_count: 0 },
        { event: 'order_created', events: 10, quantity_or_items: 15, value_lei: 2500, result_count: 0 },
      ] }), { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.match(request.url, /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/a{32}\/analytics_engine\/sql$/);
  assert.equal(request.options.headers.authorization, 'Bearer reader-secret');
  assert.doesNotMatch(request.options.body, /reader-secret/);
  assert.deepEqual(result, {
    configured: true,
    source: 'analytics-engine',
    metrics: {
      views: 200,
      addToCart: 40,
      searches: 25,
      checkoutStarted: 20,
      ordersCreated: 10,
      addedUnits: 55,
      orderValue: 2500,
      searchResults: 300,
      addToCartRate: 20,
      checkoutConversionRate: 50,
      orderConversionRate: 5,
    },
  });
});

test('wrangler config isolates preview/production Analytics Engine datasets and commits no reader secret', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /\[\[env\.preview\.analytics_engine_datasets\]\][\s\S]*binding = "PRODUCT_ANALYTICS"[\s\S]*dataset = "nailmania_product_events_preview"/);
  assert.match(toml, /\[\[env\.production\.analytics_engine_datasets\]\][\s\S]*binding = "PRODUCT_ANALYTICS"[\s\S]*dataset = "nailmania_product_events_production"/);
  assert.doesNotMatch(toml, /^ANALYTICS_READ_TOKEN\s*=/m);
  assert.doesNotMatch(toml, /^ANALYTICS_INDEX_SECRET\s*=/m);
});
