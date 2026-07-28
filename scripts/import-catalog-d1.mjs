import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  catalogImageUrls,
  CatalogValidationError,
  sha256,
  validateImportCatalog,
} from './catalog-integrity.mjs';

const ROOT = process.cwd();
const cliArgs = process.argv.slice(2);
const applyLocal = cliArgs.includes('--apply-local');
const forbiddenRemoteFlags = ['--apply-preview', '--apply-production', '--confirm-production']
  .filter((flag) => cliArgs.includes(flag));
if (forbiddenRemoteFlags.length) {
  throw new Error(
    'Direct remote catalog apply is disabled; use the guarded release:d1:catalog:<environment> command',
  );
}
const catalog = JSON.parse(readFileSync(path.join(ROOT, 'src', 'catalog.json'), 'utf8'));
const categories = JSON.parse(readFileSync(path.join(ROOT, 'src', 'categories.json'), 'utf8'));
const outputDir = path.join(ROOT, 'tmp', 'd1');
mkdirSync(outputDir, { recursive: true });
const validation = validateImportCatalog(catalog, categories);
const validationPath = path.join(outputDir, 'catalog-import-validation.json');
writeFileSync(validationPath, `${JSON.stringify(validation, null, 2)}\n`);
if (!validation.valid) {
  throw new CatalogValidationError(
    `Catalog is not importable (${validation.errorCount} error(s)); see ${path.relative(ROOT, validationPath)}`,
    validation,
  );
}

const quote = (value) => value === null || value === undefined
  ? 'NULL'
  : `'${String(value).replaceAll("'", "''")}'`;
const integer = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
const boolean = (value) => value ? 1 : 0;
const objectKey = (url) => {
  try { return new URL(url).pathname.replace(/^\//, ''); }
  catch { return ''; }
};

const keys = new Set();
const duplicateKeys = [];
for (const product of catalog) {
  if (!product.key || keys.has(product.key)) duplicateKeys.push(product.key || '(blank)');
  keys.add(product.key);
}
if (duplicateKeys.length) throw new Error(`Catalog contains duplicate/blank keys: ${duplicateKeys.slice(0, 10).join(', ')}`);

const categoryIds = new Set(categories.map((category) => category.id));
const missingCategories = [...new Set(catalog.map((product) => product.cat).filter((id) => !categoryIds.has(id)))];
if (missingCategories.length) throw new Error(`Catalog references missing categories: ${missingCategories.join(', ')}`);

const sql = [
  'PRAGMA foreign_keys = ON;',
  '-- Metadata is synchronized from the source catalog. Stock is only initialized when no operational movements exist.',
  "UPDATE products SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE source_type = 'import';",
  "UPDATE categories SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE source_type = 'import';",
];

categories.forEach((category, sortOrder) => {
  sql.push(`INSERT INTO categories (id, slug, name_ro, name_ru, sort_order, is_active, source_type)
VALUES (${quote(category.id)}, ${quote(category.id)}, ${quote(category.label || category.id)}, ${quote(category.label || category.id)}, ${sortOrder}, 1, 'import')
ON CONFLICT(id) DO UPDATE SET name_ro = excluded.name_ro, sort_order = excluded.sort_order, is_active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE categories.source_type = 'import';`);
});

for (const product of catalog) {
  const key = String(product.key);
  const stock = Math.max(0, integer(product.stock));
  const specs = JSON.stringify(Array.isArray(product.specs) ? product.specs : []);
  sql.push(`INSERT INTO products (
  catalog_key, sku, slug, category_id, brand, name_ro, name_ru, description_ro,
  price, old_price, specs_json, is_active, is_featured, is_new, is_promo, is_summer, source_type
) VALUES (
  ${quote(key)}, ${quote(product.code || '')}, ${quote(key)}, ${quote(product.cat)}, ${quote(product.brand || 'Fără brand')},
  ${quote(product.name)}, ${quote(product.nameRu || product.name)}, ${quote(product.desc || '')},
  ${integer(product.price)}, ${integer(product.old)}, ${quote(specs)}, 1, 0,
  ${boolean(product.isNew)}, ${boolean(product.promo)}, ${boolean(product.summer)}, 'import'
)
ON CONFLICT(catalog_key) DO UPDATE SET
  sku = excluded.sku,
  category_id = excluded.category_id,
  brand = excluded.brand,
  name_ro = excluded.name_ro,
  name_ru = excluded.name_ru,
  description_ro = excluded.description_ro,
  price = excluded.price,
  old_price = excluded.old_price,
  specs_json = excluded.specs_json,
  is_active = 1,
  is_new = excluded.is_new,
  is_promo = excluded.is_promo,
  is_summer = excluded.is_summer,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE products.source_type = 'import';`);

  sql.push(`DELETE FROM product_images WHERE product_id = (
  SELECT id FROM products WHERE catalog_key = ${quote(key)} AND source_type = 'import'
);`);
  catalogImageUrls(product.image).forEach((url, sortOrder) => {
    sql.push(`INSERT INTO product_images (product_id, object_key, public_url, alt_ro, alt_ru, sort_order, is_primary)
SELECT id, ${quote(objectKey(url))}, ${quote(url)}, ${quote(product.name)}, ${quote(product.nameRu || product.name)}, ${sortOrder}, ${sortOrder === 0 ? 1 : 0}
FROM products WHERE catalog_key = ${quote(key)} AND source_type = 'import';`);
  });

  sql.push(`INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved)
SELECT id, 1, ${stock}, 0 FROM products WHERE catalog_key = ${quote(key)} AND source_type = 'import'
ON CONFLICT(product_id, warehouse_id) DO UPDATE SET
  on_hand = excluded.on_hand,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (
  SELECT 1 FROM inventory_movements m
  WHERE m.product_id = inventory.product_id AND m.warehouse_id = inventory.warehouse_id
    AND m.movement_type <> 'opening_balance'
);`);
  sql.push(`INSERT INTO inventory_movements (
  id, product_id, warehouse_id, movement_type, delta_on_hand, delta_reserved,
  balance_on_hand, balance_reserved, reason
)
SELECT ${quote(`opening:${key}`)}, id, 1, 'opening_balance', ${stock}, 0, ${stock}, 0, 'Initial catalog import'
FROM products WHERE catalog_key = ${quote(key)} AND source_type = 'import'
ON CONFLICT(id) DO UPDATE SET
  delta_on_hand = excluded.delta_on_hand,
  balance_on_hand = excluded.balance_on_hand
WHERE NOT EXISTS (
  SELECT 1 FROM inventory_movements m
  WHERE m.product_id = excluded.product_id AND m.warehouse_id = excluded.warehouse_id
    AND m.movement_type <> 'opening_balance'
);`);
}

sql.push(`UPDATE inventory
SET on_hand = 0, reserved = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE product_id IN (SELECT id FROM products WHERE is_active = 0)
  AND product_id IN (SELECT id FROM products WHERE source_type = 'import')
  AND NOT EXISTS (
    SELECT 1 FROM inventory_movements m
    WHERE m.product_id = inventory.product_id AND m.movement_type <> 'opening_balance'
  );`);
sql.push(`UPDATE inventory_movements
SET delta_on_hand = 0, balance_on_hand = 0, balance_reserved = 0
WHERE movement_type = 'opening_balance'
  AND product_id IN (SELECT id FROM products WHERE is_active = 0)
  AND product_id IN (SELECT id FROM products WHERE source_type = 'import')
  AND NOT EXISTS (
    SELECT 1 FROM inventory_movements m
    WHERE m.product_id = inventory_movements.product_id AND m.movement_type <> 'opening_balance'
  );`);
sql.push(`UPDATE catalog_cache_state
SET revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1;`);

const sqlPath = path.join(outputDir, 'catalog-import.sql');
const sqlText = `${sql.join('\n\n')}\n`;
writeFileSync(sqlPath, sqlText);

const summary = {
  generatedAt: new Date().toISOString(),
  source: 'src/catalog.json',
  products: catalog.length,
  categories: categories.length,
  totalStock: catalog.reduce((sum, product) => sum + Math.max(0, integer(product.stock)), 0),
  images: catalog.reduce((sum, product) => sum + catalogImageUrls(product.image).length, 0),
  catalogSha256: validation.catalogSha256,
  categoriesSha256: validation.categoriesSha256,
  sqlSha256: sha256(sqlText),
  validationFile: path.relative(ROOT, validationPath),
  sqlFile: path.relative(ROOT, sqlPath),
};
writeFileSync(path.join(outputDir, 'catalog-import-report.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`Prepared ${summary.products} products, ${summary.categories} categories, ${summary.totalStock} units, ${summary.images} images`);
console.log(`Catalog SHA-256: ${summary.catalogSha256}`);
console.log(`SQL SHA-256: ${summary.sqlSha256}`);
console.log(`SQL: ${summary.sqlFile}`);

const target = applyLocal
  ? {
      database: 'nailmania-local',
      locationFlag: '--local',
      config: 'wrangler.local.jsonc',
      extraArgs: ['--persist-to', '.wrangler/state'],
      label: 'local D1',
    }
  : null;

if (target) {
  const executable = process.execPath;
  const wranglerArgs = [
    path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    'd1', 'execute', target.database, target.locationFlag,
    '--config', target.config, ...target.extraArgs, '--file', sqlPath,
  ];
  const result = spawnSync(executable, wranglerArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exit(result.status || 1);
  }
  console.log(`Applied catalog to ${target.label} successfully`);
}
