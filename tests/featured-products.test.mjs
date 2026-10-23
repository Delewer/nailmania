import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';
import { migrationNames } from './helpers/full-schema.mjs';

const beforeSeed = migrationNames
  .filter((name) => name !== '0020_seed_featured_products.sql')
  .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))
  .join('\n');
const seedMigration = readFileSync(new URL('../migrations/0020_seed_featured_products.sql', import.meta.url), 'utf8');

test('featured migration initializes one seasonal trend per category without replacing a curated selection', (t) => {
  const db = new SqliteD1(beforeSeed);
  t.after(() => db.close());
  db.sqlite.exec(`
    INSERT INTO categories (id, slug, name_ro, sort_order) VALUES
      ('a', 'a', 'A', 1), ('b', 'b', 'B', 2), ('c', 'c', 'C', 3);
    INSERT INTO products (id, catalog_key, sku, slug, category_id, name_ro, price) VALUES
      (1, 'A-1', 'A-1', 'a-1', 'a', 'A unu', 10),
      (2, 'A-2', 'A-2', 'a-2', 'a', 'A doi', 10),
      (3, 'B-1', 'B-1', 'b-1', 'b', 'B unu', 10),
      (4, 'C-1', 'C-1', 'c-1', 'c', 'C unu', 10);
  `);
  db.sqlite.exec(seedMigration);
  assert.deepEqual(
    db.sqlite.prepare('SELECT catalog_key FROM products WHERE is_featured = 1 ORDER BY id').all().map((row) => row.catalog_key),
    ['A-1', 'B-1', 'C-1'],
  );

  db.sqlite.exec('UPDATE products SET is_featured = CASE WHEN id = 2 THEN 1 ELSE 0 END;');
  db.sqlite.exec(seedMigration);
  assert.deepEqual(
    db.sqlite.prepare('SELECT catalog_key FROM products WHERE is_featured = 1 ORDER BY id').all().map((row) => row.catalog_key),
    ['A-2'],
  );
});
