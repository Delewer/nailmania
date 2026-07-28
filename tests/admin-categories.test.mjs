import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AdminCategoryError,
  normalizeAdminCategory,
  slugifyCategory,
} from '../functions/_lib/admin-categories.js';
import {
  onRequestGet as listCategories,
  onRequestPost as createCategory,
} from '../functions/api/admin/categories/index.js';
import {
  onRequestDelete as deleteCategory,
  onRequestPatch as updateCategory,
} from '../functions/api/admin/categories/[id].js';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';

const schema = [
  readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0002_order_transitions.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0003_admin_products.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0004_admin_categories.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../migrations/0007_catalog_cache.sql', import.meta.url), 'utf8'),
].join('\n');

function setup() {
  const db = new SqliteD1(schema);
  db.sqlite.prepare(`
    INSERT INTO categories (id, slug, name_ro, name_ru, sort_order)
    VALUES ('test', 'test', 'Test', 'Тест', 0)
  `).run();
  db.sqlite.prepare(`
    INSERT INTO users (id, email, name, role, status)
    VALUES ('admin-1', 'admin@example.test', 'Test Administrator', 'admin', 'active')
  `).run();
  return db;
}

const env = (db) => ({
  DB: db,
  ENVIRONMENT: 'local',
  ADMIN_DEV_TOKEN: 'test-secret',
  ADMIN_DEV_EMAIL: 'admin@example.test',
});

function context(db, path, method = 'GET', body, params = {}) {
  return {
    env: env(db),
    params,
    request: new Request(`http://127.0.0.1:8788${path}`, {
      method,
      headers: {
        authorization: 'Bearer test-secret',
        origin: 'http://127.0.0.1:8788',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  };
}

test('normalizes category fields and creates a stable Latin URL key', () => {
  assert.equal(slugifyCategory('Îngrijire mâini și picioare'), 'ingrijire-maini-si-picioare');
  const category = normalizeAdminCategory({ nameRo: 'Îngrijire mâini', sortOrder: 4 });
  assert.equal(category.slug, 'ingrijire-maini');
  assert.equal(category.sortOrder, 4);
  assert.throws(
    () => normalizeAdminCategory({ nameRo: 'Только кириллица' }),
    (error) => error instanceof AdminCategoryError && error.code === 'INVALID_CATEGORY_SLUG',
  );
});

test('admin category lifecycle uses revisions and records audit entries', async (t) => {
  const db = setup();
  t.after(() => db.close());

  const createResponse = await createCategory(context(db, '/api/admin/categories', 'POST', {
    nameRo: 'Îngrijire mâini',
    nameRu: 'Уход за руками',
    seoTitleRo: 'Îngrijire profesională',
  }));
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).category;
  assert.equal(created.id, 'ingrijire-maini');
  assert.equal(created.sortOrder, 1);
  assert.equal(created.sourceType, 'admin');

  const listResponse = await listCategories(context(db, '/api/admin/categories?state=active'));
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.counts.active, 2);
  assert.equal(list.items.some((category) => category.id === created.id), true);

  const updateResponse = await updateCategory(context(
    db,
    `/api/admin/categories/${created.id}`,
    'PATCH',
    { revision: created.revision, nameRo: 'Îngrijire pentru mâini', sortOrder: 3 },
    { id: created.id },
  ));
  assert.equal(updateResponse.status, 200);
  const updated = (await updateResponse.json()).category;
  assert.equal(updated.nameRo, 'Îngrijire pentru mâini');
  assert.equal(updated.slug, created.slug);
  assert.notEqual(updated.revision, created.revision);

  const staleResponse = await updateCategory(context(
    db,
    `/api/admin/categories/${created.id}`,
    'PATCH',
    { revision: created.revision, nameRo: 'Stale' },
    { id: created.id },
  ));
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).error.code, 'CATEGORY_REVISION_CONFLICT');

  const deleteResponse = await deleteCategory(context(
    db,
    `/api/admin/categories/${created.id}`,
    'DELETE',
    { revision: updated.revision },
    { id: created.id },
  ));
  assert.equal(deleteResponse.status, 200);
  const deleted = (await deleteResponse.json()).category;
  assert.equal(deleted.isActive, false);

  const restoreResponse = await updateCategory(context(
    db,
    `/api/admin/categories/${created.id}`,
    'PATCH',
    { revision: deleted.revision, isActive: true },
    { id: created.id },
  ));
  assert.equal(restoreResponse.status, 200);
  assert.equal((await restoreResponse.json()).category.isActive, true);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE entity_type = 'category'").get().count, 4);
  assert.equal(db.sqlite.prepare('SELECT revision FROM catalog_cache_state WHERE id = 1').get().revision, 5);
});

test('a category with products cannot be deactivated', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const createResponse = await createCategory(context(db, '/api/admin/categories', 'POST', { nameRo: 'Categorie ocupată' }));
  const created = (await createResponse.json()).category;
  db.sqlite.prepare(`
    INSERT INTO products (catalog_key, sku, slug, category_id, name_ro, price)
    VALUES ('CAT-PRODUCT', 'CAT-PRODUCT', 'CAT-PRODUCT', ?, 'Produs', 10)
  `).run(created.id);

  const deleteResponse = await deleteCategory(context(
    db,
    `/api/admin/categories/${created.id}`,
    'DELETE',
    { revision: created.revision },
    { id: created.id },
  ));
  assert.equal(deleteResponse.status, 409);
  const deletePayload = await deleteResponse.json();
  assert.equal(deletePayload.error.code, 'CATEGORY_IN_USE');
  assert.equal(deletePayload.error.details.productCount, 1);

  const patchResponse = await updateCategory(context(
    db,
    `/api/admin/categories/${created.id}`,
    'PATCH',
    { revision: created.revision, isActive: false },
    { id: created.id },
  ));
  assert.equal(patchResponse.status, 409);
  assert.equal((await patchResponse.json()).error.code, 'CATEGORY_IN_USE');
});
