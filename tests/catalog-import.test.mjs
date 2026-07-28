import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  catalogImageUrls,
  validateCatalogSheetText,
  validateImportCatalog,
} from '../scripts/catalog-integrity.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'));
const IMPORTER = path.join(ROOT, 'scripts', 'import-catalog-d1.mjs');
const BUILDER = path.join(ROOT, 'scripts', 'build-catalog.mjs');
const REQUIRED_HEADER = 'Brand,SKU,Category,Title,Text,Quantity,Price,Price Old,Sale,New,Promo,Foto';
const IMPORT_SCHEMA_FILES = [
  '0001_initial.sql',
  '0002_order_transitions.sql',
  '0003_admin_products.sql',
  '0004_admin_categories.sql',
  '0007_catalog_cache.sql',
];
const importSchema = () => IMPORT_SCHEMA_FILES
  .map((file) => readFileSync(path.join(ROOT, 'migrations', file), 'utf8'))
  .join('\n');

function product(overrides = {}) {
  return {
    key: 'SKU-1',
    code: 'SKU-1',
    cat: 'gellac',
    brand: 'Brand',
    name: 'Produs',
    nameRu: 'Товар',
    desc: 'Descriere',
    price: 100,
    old: 0,
    stock: 4,
    ...overrides,
  };
}

function fixtureDirectory(t, catalog, categories = [{ id: 'gellac', label: 'Gel lac' }]) {
  const directory = mkdtempSync(path.join(tmpdir(), 'nailmania-catalog-'));
  mkdirSync(path.join(directory, 'src'));
  writeFileSync(path.join(directory, 'src', 'catalog.json'), `${JSON.stringify(catalog)}\n`);
  writeFileSync(path.join(directory, 'src', 'categories.json'), `${JSON.stringify(categories)}\n`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runImporter(cwd, args = []) {
  return spawnSync(process.execPath, [IMPORTER, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_lifecycle_event: '' },
  });
}

test('sheet validation produces a deterministic checksum and rejects blank/case-insensitive duplicate SKU', () => {
  const csv = [
    REQUIRED_HEADER,
    'Brand, sku-1 ,Gel lac,One,Description,2,100,0,,,,https://example.test/1.jpg',
    'Brand,SKU-1,Gel lac,Two,Description,3,110,0,,,,https://example.test/2.jpg',
    'Brand,,Gel lac,Three,Description,1,120,0,,,,https://example.test/3.jpg',
  ].join('\n');
  const first = validateCatalogSheetText(csv, { checkedAt: '2026-07-16T00:00:00.000Z' });
  const second = validateCatalogSheetText(csv.replaceAll('\n', '\r\n'), {
    checkedAt: '2026-07-16T00:00:00.000Z',
  });

  assert.equal(first.report.valid, false);
  assert.equal(first.report.errors.blankSku.length, 1);
  assert.equal(first.report.errors.duplicateSku.length, 1);
  assert.equal(first.report.errors.duplicateSku[0].identity, 'SKU-1');
  assert.equal(first.report.snapshotSha256, second.report.snapshotSha256);
  assert.equal(first.snapshotText, second.snapshotText);
});

test('import validation requires stable, non-blank, unique SKU-backed keys', () => {
  const report = validateImportCatalog([
    product(),
    product({ key: 'SKU-1-2', code: 'sku-1', name: 'Duplicate' }),
    product({ key: 'generated-key', code: '', name: 'Blank' }),
  ], [{ id: 'gellac', label: 'Gel lac' }]);

  assert.equal(report.valid, false);
  assert.equal(report.errors.blankSku.length, 1);
  assert.equal(report.errors.duplicateSku.length, 1);
  assert.equal(report.errors.unstableKey.length, 1);
});

test('catalog image parsing preserves query commas and deduplicates whitespace-separated URLs', () => {
  const transformed = 'https://cdn.example.test/Q10.jpg?x=image/format,webp/quality,q_100';
  const alternate = 'https://cdn.example.test/Q10-side.webp';

  assert.deepEqual(
    catalogImageUrls(`${transformed}\n${alternate}\t${alternate}`),
    [transformed, alternate],
  );
});

test('sheet validation preserves quoted comma-query images and rejects malformed URL fragments', () => {
  const transformed = 'https://cdn.example.test/Q10.jpg?x=image/format,webp/quality,q_100';
  const valid = validateCatalogSheetText([
    REQUIRED_HEADER,
    `Brand,SKU-1,Gel lac,One,Description,2,100,0,,,,"${transformed}"`,
  ].join('\n'));
  const invalid = validateCatalogSheetText([
    REQUIRED_HEADER,
    `Brand,SKU-1,Gel lac,One,Description,2,100,0,,,,"${transformed} broken-fragment"`,
  ].join('\n'));

  assert.equal(valid.report.valid, true);
  assert.equal(valid.report.errors.invalidImageUrl.length, 0);
  assert.equal(invalid.report.valid, false);
  assert.deepEqual(invalid.report.errors.invalidImageUrl, [{
    row: 2,
    sku: 'SKU-1',
    title: 'One',
    url: 'broken-fragment',
  }]);
});

test('import validation rejects malformed image URL fragments', () => {
  const report = validateImportCatalog([
    product({ image: 'https://cdn.example.test/product.webp broken-fragment' }),
  ], [{ id: 'gellac', label: 'Gel lac' }]);

  assert.equal(report.valid, false);
  assert.equal(report.errors.invalidImageUrl.length, 1);
  assert.equal(report.errors.invalidImageUrl[0].url, 'broken-fragment');

  const ambiguousDelimiter = validateImportCatalog([
    product({ image: 'https://cdn.example.test/one.webp,https://cdn.example.test/two.webp' }),
  ], [{ id: 'gellac', label: 'Gel lac' }]);
  assert.equal(ambiguousDelimiter.valid, false);
  assert.equal(ambiguousDelimiter.errors.invalidImageUrl.length, 1);
});

test('generated import keeps comma query URLs intact and removes repeated images', (t) => {
  const transformed = 'https://cdn.example.test/Q10.jpg?x=image/format,webp/quality,q_100';
  const alternate = 'https://cdn.example.test/Q10-side.webp';
  const directory = fixtureDirectory(t, [
    product({ image: `${transformed} ${alternate} ${alternate}` }),
  ]);

  const result = runImporter(directory);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(
    path.join(directory, 'tmp', 'd1', 'catalog-import-report.json'),
    'utf8',
  ));
  const sql = readFileSync(path.join(directory, 'tmp', 'd1', 'catalog-import.sql'), 'utf8');

  assert.equal(report.images, 2);
  assert.equal(sql.split(transformed).length - 1, 1);
  assert.equal(sql.split(alternate).length - 1, 1);
  assert.equal(sql.includes("'webp/quality'"), false);
  assert.equal(sql.includes("'q_100'"), false);

  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(importSchema());
  database.exec(sql);
  assert.deepEqual(
    database.prepare(`
      SELECT public_url, sort_order, is_primary
      FROM product_images
      ORDER BY sort_order, id
    `).all().map((row) => ({ ...row })),
    [
      { public_url: transformed, sort_order: 0, is_primary: 1 },
      { public_url: alternate, sort_order: 1, is_primary: 0 },
    ],
  );
});

test('importer rejects malformed image data before producing SQL', (t) => {
  const directory = fixtureDirectory(t, [
    product({ image: 'https://cdn.example.test/product.webp broken-fragment' }),
  ]);
  const result = runImporter(directory);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Catalog is not importable/);
  const validation = JSON.parse(readFileSync(
    path.join(directory, 'tmp', 'd1', 'catalog-import-validation.json'),
    'utf8',
  ));
  assert.equal(validation.errors.invalidImageUrl.length, 1);
  assert.throws(
    () => readFileSync(path.join(directory, 'tmp', 'd1', 'catalog-import.sql')),
    /ENOENT/,
  );
});

test('strict build consumes the validated bytes and rejects a checksum mismatch before overwriting output', (t) => {
  const transformed = 'https://cdn.example.test/Q10.jpg?x=image/format,webp/quality,q_100';
  const csv = [
    REQUIRED_HEADER,
    `Brand,SKU-1,Gel lac,One,Description,2,100,0,,,,"${transformed}"`,
  ].join('\n');
  const { snapshotText, report } = validateCatalogSheetText(csv, {
    checkedAt: '2026-07-16T00:00:00.000Z',
  });
  assert.equal(report.valid, true);

  const directory = mkdtempSync(path.join(tmpdir(), 'nailmania-catalog-build-'));
  mkdirSync(path.join(directory, 'src'));
  mkdirSync(path.join(directory, 'tmp'));
  writeFileSync(path.join(directory, 'catalog.config.json'), `${JSON.stringify({
    sheetUrl: '',
    imagePolicy: {
      canonicalBaseUrl: 'https://images.nailmania.md',
      productionBucket: 'nailmania-photos',
      legacySameBucketOrigins: ['https://legacy-images.example.test'],
      externalUrlMapFile: 'catalog-image-url-map.json',
    },
  })}\n`);
  writeFileSync(path.join(directory, 'catalog-image-url-map.json'), '{}\n');
  writeFileSync(path.join(directory, 'nailmania-sheet.csv'), snapshotText);
  writeFileSync(path.join(directory, 'tmp', 'catalog-source.csv'), snapshotText);
  writeFileSync(path.join(directory, 'tmp', 'catalog-validation.json'), `${JSON.stringify(report)}\n`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const args = [
    BUILDER,
    '--validated-snapshot', 'tmp/catalog-source.csv',
    '--validation-report', 'tmp/catalog-validation.json',
  ];
  const built = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const catalogPath = path.join(directory, 'src', 'catalog.json');
  assert.deepEqual(JSON.parse(readFileSync(catalogPath, 'utf8')).map(({ key, code }) => ({ key, code })), [
    { key: 'SKU-1', code: 'SKU-1' },
  ]);
  assert.equal(JSON.parse(readFileSync(catalogPath, 'utf8'))[0].image, transformed);
  assert.equal(
    JSON.parse(readFileSync(path.join(directory, 'tmp', 'catalog-build-integrity.json'), 'utf8')).valid,
    true,
  );

  const originalCatalog = readFileSync(catalogPath, 'utf8');
  writeFileSync(path.join(directory, 'tmp', 'catalog-source.csv'), snapshotText.replace('One', 'Tampered'));
  const tampered = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8' });
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /checksum mismatch/);
  assert.equal(readFileSync(catalogPath, 'utf8'), originalCatalog);
});

test('prepare-only and local importer refuse invalid catalog data before producing SQL or invoking Wrangler', (t) => {
  const directory = fixtureDirectory(t, [product({ code: '' })]);
  const targets = [
    [],
    ['--apply-local'],
  ];

  for (const args of targets) {
    const result = runImporter(directory, args);
    assert.notEqual(result.status, 0, args.join(' ') || 'prepare-only');
    assert.match(result.stderr, /Catalog is not importable/);
    assert.equal(
      JSON.parse(readFileSync(path.join(directory, 'tmp', 'd1', 'catalog-import-validation.json'), 'utf8')).valid,
      false,
    );
    assert.equal(result.stdout.includes('Applied catalog'), false);
  }
  assert.equal(
    (() => {
      try {
        readFileSync(path.join(directory, 'tmp', 'd1', 'catalog-import.sql'));
        return true;
      } catch {
        return false;
      }
    })(),
    false,
  );
});

test('direct remote catalog invocation is disabled in favor of the guarded release wrapper', (t) => {
  const directory = fixtureDirectory(t, [product()]);
  for (const args of [
    ['--apply-preview'],
    ['--apply-production'],
    ['--apply-production', '--confirm-production'],
  ]) {
    const result = runImporter(directory, args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Direct remote catalog apply is disabled/);
    assert.equal(result.stderr.includes('Catalog is not importable'), false);
    assert.equal(result.stdout.includes('Applied catalog'), false);
  }
});

test('generated import preserves admin-owned products, categories, and inventory', (t) => {
  const directory = fixtureDirectory(t, [product()], [{ id: 'gellac', label: 'Imported label' }]);
  const result = runImporter(directory);
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(readFileSync(path.join(directory, 'tmp', 'd1', 'catalog-import-report.json'), 'utf8'));
  const sql = readFileSync(path.join(directory, 'tmp', 'd1', 'catalog-import.sql'), 'utf8');
  assert.match(report.catalogSha256, /^[a-f0-9]{64}$/);
  assert.match(report.categoriesSha256, /^[a-f0-9]{64}$/);
  assert.match(report.sqlSha256, /^[a-f0-9]{64}$/);

  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(importSchema());
  database.exec(`
    INSERT INTO categories (id, slug, name_ro, name_ru, source_type)
    VALUES ('gellac', 'manual-category', 'Manual category', 'Ручная категория', 'admin');
    INSERT INTO categories (id, slug, name_ro, name_ru, source_type, is_active)
    VALUES
      ('stale-import', 'stale-import', 'Stale import', 'Старый импорт', 'import', 1),
      ('admin-extra', 'admin-extra', 'Admin extra', 'Доп. админ', 'admin', 1);
    INSERT INTO products (
      catalog_key, sku, slug, category_id, brand, name_ro, name_ru, price, source_type, admin_revision
    ) VALUES (
      'SKU-1', 'MANUAL-SKU', 'manual-product', 'gellac', 'Manual brand',
      'Manual product', 'Ручной товар', 999, 'admin', 'manual-revision'
    );
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, admin_revision)
    SELECT id, 1, 7, 0, 'manual-stock' FROM products WHERE catalog_key = 'SKU-1';
  `);

  database.exec(sql);
  assert.deepEqual(
    { ...database.prepare(`
      SELECT sku, slug, brand, name_ro, price, source_type, admin_revision
      FROM products WHERE catalog_key = 'SKU-1'
    `).get() },
    {
      sku: 'MANUAL-SKU',
      slug: 'manual-product',
      brand: 'Manual brand',
      name_ro: 'Manual product',
      price: 999,
      source_type: 'admin',
      admin_revision: 'manual-revision',
    },
  );
  assert.deepEqual(
    { ...database.prepare(`SELECT name_ro, slug, source_type FROM categories WHERE id = 'gellac'`).get() },
    { name_ro: 'Manual category', slug: 'manual-category', source_type: 'admin' },
  );
  assert.equal(
    database.prepare("SELECT is_active FROM categories WHERE id = 'stale-import'").get().is_active,
    0,
  );
  assert.equal(
    database.prepare("SELECT is_active FROM categories WHERE id = 'admin-extra'").get().is_active,
    1,
  );
  assert.deepEqual(
    { ...database.prepare(`
      SELECT on_hand, reserved, admin_revision
      FROM inventory WHERE product_id = (SELECT id FROM products WHERE catalog_key = 'SKU-1')
    `).get() },
    { on_hand: 7, reserved: 0, admin_revision: 'manual-stock' },
  );
  assert.equal(database.prepare('SELECT revision FROM catalog_cache_state WHERE id = 1').get().revision, 2);
});

test('checked-in generated catalog is importable', () => {
  const catalog = JSON.parse(readFileSync(path.join(ROOT, 'src', 'catalog.json'), 'utf8'));
  const categories = JSON.parse(readFileSync(path.join(ROOT, 'src', 'categories.json'), 'utf8'));
  const report = validateImportCatalog(catalog, categories);

  assert.equal(report.valid, true, JSON.stringify(report.errors));
  assert.equal(report.errorCount, 0);
});
