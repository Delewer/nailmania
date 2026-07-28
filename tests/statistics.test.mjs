import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';
import {
  buildCsvReport,
  encodeCsv,
  loadStatistics,
  parseStatisticsQuery,
} from '../functions/_lib/statistics.js';
import { onRequestGet as statisticsEndpoint } from '../functions/api/admin/statistics/index.js';
import { onRequestGet as statisticsEventsEndpoint } from '../functions/api/admin/statistics/events.js';
import { onRequestGet as statisticsExportEndpoint } from '../functions/api/admin/statistics/export.js';

const migration = (name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
const schema = [
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
].map(migration).join('\n');

const FROM = '2026-07-10T00:00:00.000Z';
const TO = '2026-07-17T00:00:00.000Z';

function filters(overrides = {}) {
  const params = new URLSearchParams({ from: FROM, to: TO, ...overrides });
  return parseStatisticsQuery(params);
}

function setup() {
  const db = new SqliteD1(schema);
  db.sqlite.exec(`
    INSERT INTO categories (id, slug, name_ro, name_ru)
    VALUES ('cat-a', 'cat-a', 'Categorie redenumită', 'Переименованная'),
           ('cat-b', 'cat-b', 'Fără vânzări', 'Без продаж');

    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, brand, name_ro, name_ru,
      price, old_price, cost_price, low_stock_threshold
    ) VALUES
      (1, 'P1', 'SKU-1', 'p1', 'cat-a', 'Brand A', 'Produs unu', 'Товар один', 100, 120, 40, 2),
      (2, 'P2', '=FORMULA', 'p2', 'cat-b', 'Brand B', '=Produs riscant', 'Товар', 200, 0, NULL, 2),
      (3, 'P3', 'SKU-3', 'p3', 'cat-a', 'Brand A', 'Produs trei', 'Товар три', 80, 0, 50, 2),
      (4, 'P4', 'SKU-4', 'p4', 'cat-b', 'Brand C', 'Produs patru', 'Товар четыре', 60, 0, NULL, 2);

    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved) VALUES
      (1, 1, 5, 1), (2, 1, 0, 0), (3, 1, 2, 1), (4, 1, 4, 0);

    INSERT INTO users (id, email, name, role, status)
    VALUES ('manager-1', 'manager@example.test', 'Manager', 'manager', 'active'),
           ('admin-1', 'admin@example.test', 'Admin', 'admin', 'active'),
           ('customer-1', 'customer@example.test', 'Customer', 'customer', 'active');

    INSERT INTO orders (
      id, order_no, status, customer_name, customer_phone, delivery_method,
      delivery_label, delivery_fee, payment_method, payment_label,
      items_subtotal, catalog_discount, promo_discount, total_amount,
      completed_at, created_at
    ) VALUES
      ('order-a', 'NM-A', 'completed', 'Ana', '0600', 'courier', 'Curier', 70, 'cash', 'Cash', 200, 40, 20, 250, '2026-07-10T10:00:00.000Z', '2026-07-09T10:00:00.000Z'),
      ('order-b', 'NM-B', 'returned', 'Bia', '0601', 'pickup', 'Pickup', 0, 'cash', 'Cash', 100, 20, 0, 100, '2026-07-12T10:00:00.000Z', '2026-07-11T10:00:00.000Z'),
      ('order-old', 'NM-OLD', 'returned', 'Cora', '0602', 'pickup', 'Pickup', 0, 'cash', 'Cash', 80, 0, 0, 80, '2026-07-01T10:00:00.000Z', '2026-07-01T09:00:00.000Z'),
      ('order-pending', 'NM-PENDING', 'pending', 'Dan', '0603', 'pickup', 'Pickup', 0, 'cash', 'Cash', 200, 0, 0, 200, NULL, '2026-07-14T10:00:00.000Z'),
      ('order-cancelled', 'NM-CANCELLED', 'cancelled', 'Ema', '0604', 'pickup', 'Pickup', 0, 'cash', 'Cash', 200, 0, 0, 200, NULL, '2026-07-14T11:00:00.000Z');

    INSERT INTO order_items (
      id, order_id, product_id, product_key, sku, brand, name,
      unit_price, list_price, quantity, sold_quantity, returned_quantity,
      promo_discount_allocation, line_total,
      category_id_snapshot, category_name_ro_snapshot, category_name_ru_snapshot,
      cost_price_snapshot
    ) VALUES
      (1, 'order-a', 1, 'P1', 'SKU-1', 'Brand A', 'Produs unu', 100, 120, 2, 2, 1, 20, 200, 'cat-a', 'Categorie istorică', 'Историческая', 40),
      (2, 'order-b', 1, 'P1', 'SKU-1', 'Brand A', 'Produs unu', 100, 120, 1, 1, 1, 0, 100, 'cat-a', 'Categorie istorică', 'Историческая', 40),
      (3, 'order-old', 3, 'P3', 'SKU-3', 'Brand A', 'Produs trei', 80, 80, 1, 1, 1, 0, 80, 'cat-a', 'Categorie istorică', 'Историческая', 50),
      (4, 'order-pending', 2, 'P2', '=FORMULA', 'Brand B', '=Produs riscant', 200, 200, 1, 0, 0, 0, 200, 'cat-b', 'Fără vânzări', 'Без продаж', NULL),
      (5, 'order-cancelled', 2, 'P2', '=FORMULA', 'Brand B', '=Produs riscant', 200, 200, 1, 0, 0, 0, 200, 'cat-b', 'Fără vânzări', 'Без продаж', NULL);

    INSERT INTO order_returns (
      id, order_id, request_key, request_fingerprint, return_kind,
      items_amount, promo_refund_amount, reason, created_at
    ) VALUES
      ('return-a', 'order-a', 'request-a', 'fingerprint-a', 'partial', 100, 10, 'partial return', '2026-07-11T12:00:00.000Z'),
      ('return-b', 'order-b', 'request-b', 'fingerprint-b', 'full', 100, 0, 'full return', '2026-07-13T12:00:00.000Z'),
      ('return-old', 'order-old', 'request-old', 'fingerprint-old', 'full', 80, 0, 'old sale return', '2026-07-15T12:00:00.000Z');

    INSERT INTO order_return_items (
      return_id, order_item_id, product_id, quantity, unit_price,
      line_amount, promo_refund_amount
    ) VALUES
      ('return-a', 1, 1, 1, 100, 100, 10),
      ('return-b', 2, 1, 1, 100, 100, 0),
      ('return-old', 3, 3, 1, 80, 80, 0);

    INSERT INTO inventory_movements (
      id, product_id, warehouse_id, movement_type, delta_on_hand,
      delta_reserved, balance_on_hand, balance_reserved, reason, created_at
    ) VALUES
      ('move-1', 1, 1, 'receipt', 2, 0, 5, 1, '=spreadsheet payload', '2026-07-14T08:00:00.000Z'),
      ('move-old', 1, 1, 'receipt', 1, 0, 3, 0, 'outside period', '2026-07-01T08:00:00.000Z');
  `);
  return db;
}

test('strict statistics periods accept only canonical UTC half-open bounds', () => {
  const parsed = filters();
  assert.deepEqual({ from: parsed.from, to: parsed.to }, { from: FROM, to: TO });
  assert.throws(
    () => parseStatisticsQuery(new URLSearchParams({ from: '2026-07-10T03:00:00.000+03:00', to: TO })),
    (error) => error.code === 'INVALID_STATISTICS_PERIOD',
  );
  assert.throws(
    () => parseStatisticsQuery(new URLSearchParams({ from: TO, to: FROM })),
    (error) => error.code === 'INVALID_STATISTICS_PERIOD',
  );
});

test('D1 reports use finalized sales and immutable refund ledger formulas', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const report = await loadStatistics(db, filters());

  assert.deepEqual(report.period, { from: FROM, to: TO, timezone: 'UTC', semantics: '[from,to)' });
  assert.deepEqual(report.summary, {
    orders: 2,
    returnedOrders: 1,
    grossMerchandise: 360,
    merchandiseAfterCatalog: 300,
    catalogDiscount: 60,
    promoDiscount: 20,
    totalDiscount: 80,
    deliveryRevenue: 70,
    saleRevenue: 350,
    returnCount: 3,
    returnedOrderCount: 3,
    returnedUnits: 3,
    returnedMerchandise: 280,
    promoDiscountReversed: 10,
    refundAmount: 270,
    merchandiseNetRevenue: 10,
    netRevenue: 80,
    averageCheck: 40,
    cogs: -10,
    unknownCostUnits: 0,
    grossProfit: 20,
    inventory: {
      products: 4,
      outOfStock: 1,
      lowStock: 1,
      onHand: 11,
      reserved: 2,
      available: 9,
      currentCost: 300,
      unknownCostUnits: 4,
    },
  });

  const productOne = report.products.find((row) => row.id === 1);
  assert.deepEqual({
    soldUnits: productOne.soldUnits,
    returnedUnits: productOne.returnedUnits,
    netUnits: productOne.netUnits,
    netRevenue: productOne.netRevenue,
    cogs: productOne.cogs,
    grossProfit: productOne.grossProfit,
  }, { soldUnits: 3, returnedUnits: 2, netUnits: 1, netRevenue: 90, cogs: 40, grossProfit: 50 });

  const oldSaleReturn = report.products.find((row) => row.id === 3);
  assert.deepEqual({
    soldUnits: oldSaleReturn.soldUnits,
    returnedUnits: oldSaleReturn.returnedUnits,
    netUnits: oldSaleReturn.netUnits,
    netRevenue: oldSaleReturn.netRevenue,
    cogs: oldSaleReturn.cogs,
  }, { soldUnits: 0, returnedUnits: 1, netUnits: -1, netRevenue: -80, cogs: -50 });

  const category = report.categories.find((row) => row.id === 'cat-a');
  assert.equal(category.name, 'Categorie istorică');
  assert.equal(category.netRevenue, 10);
  assert.equal(report.brands.find((row) => row.id === 'Brand A').netUnits, 0);
  assert.deepEqual(report.daily, [
    { day: '2026-07-10', orders: 1, saleRevenue: 250, refundAmount: 0, netRevenue: 250 },
    { day: '2026-07-11', orders: 0, saleRevenue: 0, refundAmount: 90, netRevenue: -90 },
    { day: '2026-07-12', orders: 1, saleRevenue: 100, refundAmount: 0, netRevenue: 100 },
    { day: '2026-07-13', orders: 0, saleRevenue: 0, refundAmount: 100, netRevenue: -100 },
    { day: '2026-07-15', orders: 0, saleRevenue: 0, refundAmount: 80, netRevenue: -80 },
  ]);
});

test('product filters cover category, brand, text, no-sales, low and out stock', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const byBrand = await loadStatistics(db, filters({ brand: 'Brand A', q: 'produs' }));
  assert.deepEqual(byBrand.products.map((row) => row.id), [1, 3]);

  const noSales = await loadStatistics(db, filters({ stock: 'no_sales' }));
  assert.deepEqual(new Set(noSales.products.map((row) => row.id)), new Set([2, 3, 4]));
  const low = await loadStatistics(db, filters({ stock: 'low' }));
  assert.deepEqual(low.products.map((row) => row.id), [3]);
  const out = await loadStatistics(db, filters({ stock: 'out', category: 'cat-b' }));
  assert.deepEqual(out.products.map((row) => row.id), [2]);
});

test('CSV is UTF-8 BOM, always quoted and neutralizes spreadsheet formulas without corrupting numbers', async (t) => {
  const encoded = encodeCsv(['name', 'value'], [['=cmd|calc', -12], ['  @danger', 'a"b\nline']]);
  assert.ok(encoded.startsWith('\uFEFF'));
  assert.match(encoded, /"'=cmd\|calc","-12"/);
  assert.match(encoded, /"'  @danger","a""b\nline"/);

  const db = setup();
  t.after(() => db.close());
  const products = await buildCsvReport(db, filters({ stock: 'no_sales' }), 'products');
  assert.match(products, /"'=Produs riscant"/);
  assert.match(products, /"'=FORMULA"/);
  const inventory = await buildCsvReport(db, filters({ stock: 'no_sales' }), 'inventory');
  assert.match(inventory, /"'=Produs riscant"/);
  assert.doesNotMatch(inventory, /"Produs unu"/);
  const movements = await buildCsvReport(db, filters(), 'movements');
  assert.match(movements, /"'=spreadsheet payload"/);
  assert.doesNotMatch(movements, /outside period/);
  const sales = await buildCsvReport(db, filters(), 'sales');
  assert.match(sales, /"refund","return-old","NM-OLD"/);
});

test('statistics, event metrics and exports are admin-only', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const url = `https://shop.test/api/admin/statistics?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
  const endpointContext = (requestUrl, email) => ({
    request: new Request(requestUrl, {
      headers: { authorization: 'Bearer test-admin-token' },
    }),
    env: {
      DB: db,
      ENVIRONMENT: 'local',
      ADMIN_DEV_TOKEN: 'test-admin-token',
      ADMIN_DEV_EMAIL: email,
    },
  });

  for (const endpoint of [
    statisticsEndpoint,
    statisticsEventsEndpoint,
    statisticsExportEndpoint,
  ]) {
    const requestUrl = endpoint === statisticsExportEndpoint
      ? `${url}&report=sales`
      : url;
    const manager = await endpoint(endpointContext(requestUrl, 'manager@example.test'));
    assert.equal(manager.status, 403);
    assert.equal((await manager.json()).error.code, 'ADMIN_FORBIDDEN');
  }

  const admin = await statisticsEndpoint(endpointContext(url, 'admin@example.test'));
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get('cache-control'), 'no-store');
  assert.equal((await admin.json()).summary.netRevenue, 80);

  const adminEvents = await statisticsEventsEndpoint(
    endpointContext(url, 'admin@example.test'),
  );
  assert.equal(adminEvents.status, 200);
  assert.equal((await adminEvents.json()).configured, false);

  const adminExport = await statisticsExportEndpoint(
    endpointContext(`${url}&report=sales`, 'admin@example.test'),
  );
  assert.equal(adminExport.status, 200);
  assert.match(adminExport.headers.get('content-type'), /^text\/csv/);

  const customer = await statisticsEndpoint(
    endpointContext(url, 'customer@example.test'),
  );
  assert.equal(customer.status, 403);
});

test('0010 best-effort migration backfills existing category and purchase-cost snapshots', () => {
  const before = [
    '0001_initial.sql', '0002_order_transitions.sql', '0003_admin_products.sql',
    '0004_admin_categories.sql', '0005_customer_accounts.sql',
    '0006_returns_and_admin_journals.sql', '0007_catalog_cache.sql',
    '0008_rate_limits.sql', '0009_promotions.sql',
  ].map(migration).join('\n');
  const db = new SqliteD1(before);
  try {
    db.sqlite.exec(`
      INSERT INTO categories (id, slug, name_ro, name_ru) VALUES ('cat', 'cat', 'Categorie', 'Категория');
      INSERT INTO products (id, catalog_key, sku, slug, category_id, brand, name_ro, price, cost_price)
      VALUES (1, 'P1', 'P1', 'p1', 'cat', 'Brand', 'Produs', 100, 45);
      INSERT INTO orders (
        id, order_no, status, customer_name, customer_phone, delivery_method,
        delivery_label, payment_method, payment_label, items_subtotal,
        catalog_discount, promo_discount, total_amount
      ) VALUES ('o1', 'NM1', 'pending', 'Ana', '0600', 'pickup', 'Pickup', 'cash', 'Cash', 100, 0, 0, 100);
      INSERT INTO order_items (order_id, product_id, product_key, sku, brand, name, unit_price, list_price, quantity, line_total)
      VALUES ('o1', 1, 'P1', 'P1', 'Brand', 'Produs', 100, 100, 1, 100);
    `);
    db.sqlite.exec(migration('0010_statistics_and_analytics.sql'));
    const row = db.sqlite.prepare(`
      SELECT category_id_snapshot, category_name_ro_snapshot,
             category_name_ru_snapshot, cost_price_snapshot
      FROM order_items
    `).get();
    assert.deepEqual({ ...row }, {
      category_id_snapshot: 'cat',
      category_name_ro_snapshot: 'Categorie',
      category_name_ru_snapshot: 'Категория',
      cost_price_snapshot: 45,
    });
  } finally {
    db.close();
  }
});
