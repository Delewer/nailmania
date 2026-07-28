import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? String(args[index + 1] || '').trim() : fallback;
};
const persistTo = valueAfter('--persist-to', '.wrangler/ci-state');
const schemaOnly = args.includes('--schema-only');
const migrationFiles = readdirSync(path.join(root, 'migrations'))
  .filter((file) => file.endsWith('.sql'))
  .sort();
const migrationCount = migrationFiles.length;
const sql = `
SELECT
  (SELECT COUNT(*) FROM d1_migrations) AS migrations,
  (SELECT GROUP_CONCAT(name, '|') FROM (SELECT name FROM d1_migrations ORDER BY id)) AS migration_names,
  (SELECT COUNT(*) FROM categories) AS categories,
  (SELECT COUNT(*) FROM products) AS products,
  (SELECT COUNT(*) FROM inventory) AS inventory_rows,
  (SELECT COUNT(*) FROM inventory WHERE reserved < 0 OR reserved > on_hand) AS invalid_inventory,
  (SELECT COUNT(*) FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE c.id IS NULL) AS orphan_products,
  (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN (
    'promo_code_categories', 'promo_code_products', 'notification_attempts',
    'notification_attempt_statuses', 'order_idempotency'
  )) AS critical_tables,
  (SELECT COUNT(*) FROM pragma_table_info('order_items') WHERE name IN (
    'promo_discount_allocation', 'category_id_snapshot', 'category_name_ro_snapshot',
    'category_name_ru_snapshot', 'cost_price_snapshot'
  )) AS critical_order_item_columns,
  (SELECT COUNT(*) FROM pragma_table_info('orders') WHERE name = 'internal_comment_revision') AS critical_order_columns;
`;
const result = spawnSync(process.execPath, [
  path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
  'd1', 'execute', 'nailmania-local', '--local', '--config', 'wrangler.local.jsonc',
  '--persist-to', persistTo, '--command', sql, '--json',
], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

if (result.error) throw result.error;
if (result.status !== 0) {
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status || 1);
}

const payload = JSON.parse(result.stdout);
const findRow = (value) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRow(item);
      if (found) return found;
    }
  } else if (value && typeof value === 'object') {
    if (['migrations', 'migration_names', 'categories', 'products', 'inventory_rows', 'invalid_inventory',
      'orphan_products', 'critical_tables', 'critical_order_item_columns', 'critical_order_columns']
      .every((key) => Object.hasOwn(value, key))) return value;
    for (const item of Object.values(value)) {
      const found = findRow(item);
      if (found) return found;
    }
  }
  return null;
};
const row = findRow(payload);
if (!row) throw new Error('Could not read the local D1 smoke-test result');

const failures = [];
if (Number(row.migrations) !== migrationCount) failures.push(`expected ${migrationCount} migrations, got ${row.migrations}`);
const appliedMigrations = String(row.migration_names || '').split('|').filter(Boolean);
if (JSON.stringify(appliedMigrations) !== JSON.stringify(migrationFiles)) {
  failures.push(`migration ledger mismatch: expected ${migrationFiles.join(', ')}, got ${appliedMigrations.join(', ')}`);
}
if (!schemaOnly && Number(row.categories) < 1) failures.push('catalog has no categories');
if (!schemaOnly && Number(row.products) < 1) failures.push('catalog has no products');
if (!schemaOnly && Number(row.inventory_rows) < 1) failures.push('catalog has no inventory rows');
if (Number(row.invalid_inventory) !== 0) failures.push(`found ${row.invalid_inventory} invalid inventory rows`);
if (Number(row.orphan_products) !== 0) failures.push(`found ${row.orphan_products} products without categories`);
if (Number(row.critical_tables) !== 5) failures.push(`expected 5 critical release tables, got ${row.critical_tables}`);
if (Number(row.critical_order_item_columns) !== 5) {
  failures.push(`expected 5 critical order_items columns, got ${row.critical_order_item_columns}`);
}
if (Number(row.critical_order_columns) !== 1) failures.push('orders.internal_comment_revision is missing');
if (failures.length) throw new Error(`Local D1 smoke test failed: ${failures.join('; ')}`);

console.log(`Local D1 verified: ${row.migrations} migrations, ${row.categories} categories, ${row.products} products, ${row.inventory_rows} inventory rows${schemaOnly ? ' (schema-only)' : ''}.`);
