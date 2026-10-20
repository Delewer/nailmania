import { requireAdmin, requireSameOrigin } from '../../../_lib/admin-auth.js';
import { AdminProductError, changedRows, normalizeAdminProduct } from '../../../_lib/admin-products.js';
import { catalogRevisionBump } from '../../../_lib/catalog-cache.js';
import { apiError, handleApiError, json, readBoundedJson } from '../../../_lib/http.js';

const MAX_IMPORT_ROWS = 10;
const MAX_IMPORT_JSON_BYTES = 128 * 1024;
const placeholders = (count) => Array.from({ length: count }, () => '?').join(', ');
const requestIp = (request) => String(request.headers.get('cf-connecting-ip') || '').slice(0, 80);
const flag = (value) => value ? 1 : 0;
const text = (value, max) => String(value ?? '').trim().slice(0, max);
const skuIdentity = (value) => text(value, 80).normalize('NFKC').toLocaleUpperCase('en-US');

function importError(error) {
  if (error instanceof AdminProductError) return apiError(error.code, error.message, error.status, error.details);
  if (/UNIQUE constraint failed/i.test(String(error?.message || error))) {
    return apiError('PRODUCT_IMPORT_CONFLICT', 'A product code or URL changed while the import was running', 409);
  }
  return handleApiError(error);
}

function normalizeRequest(body) {
  if (!Array.isArray(body?.items) || !body.items.length || body.items.length > MAX_IMPORT_ROWS) {
    throw new AdminProductError(
      'INVALID_PRODUCT_IMPORT',
      `Each import request must contain from 1 to ${MAX_IMPORT_ROWS} products`,
      400,
    );
  }
  const importId = text(body.importId, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(importId)) {
    throw new AdminProductError('INVALID_PRODUCT_IMPORT', 'A valid import id is required', 400);
  }
  const sourceFile = text(body.sourceFile, 160) || 'catalog.xls';
  const seen = new Set();
  const items = body.items.map((item, index) => {
    const sheetRow = Number(item?.sheetRow);
    if (!Number.isInteger(sheetRow) || sheetRow < 1 || sheetRow > 100_000) {
      throw new AdminProductError('INVALID_PRODUCT_IMPORT', 'Every imported product needs a valid sheet row', 400, { index });
    }
    if (typeof item?.isActive !== 'boolean') {
      throw new AdminProductError('INVALID_PRODUCT_IMPORT', 'Every imported product needs an explicit active state', 400, { sheetRow });
    }
    const draft = normalizeAdminProduct({
      sku: item.sku,
      categoryId: item.categoryId,
      brand: item.brand,
      nameRo: item.nameRo,
      nameRu: item.nameRo,
      descriptionRo: '',
      descriptionRu: '',
      price: item.price,
      oldPrice: 0,
      costPrice: null,
      lowStockThreshold: 2,
      initialStock: 0,
      specs: item.specs || [],
      images: [],
      isActive: item.isActive,
      isFeatured: false,
      isNew: false,
      isPromo: false,
      isSummer: false,
    });
    const identity = skuIdentity(draft.sku);
    if (seen.has(identity)) {
      throw new AdminProductError('DUPLICATE_IMPORT_SKU', 'The same product code appears twice in one import batch', 400, {
        sheetRow,
        sku: draft.sku,
      });
    }
    seen.add(identity);
    return { sheetRow, draft, identity };
  });
  return { importId: importId.toLowerCase(), sourceFile, items };
}

async function loadExistingProducts(db, items) {
  const skus = items.map((item) => item.draft.sku);
  const slugs = items.map((item) => item.draft.slug);
  const marker = placeholders(items.length);
  const result = await db.prepare(`
    SELECT id, catalog_key, sku, slug, category_id, brand, name_ro, name_ru,
           price, old_price, is_active, deleted_at, admin_revision
    FROM products
    WHERE sku COLLATE NOCASE IN (${marker})
       OR catalog_key COLLATE NOCASE IN (${marker})
       OR slug COLLATE NOCASE IN (${marker})
  `).bind(...skus, ...skus, ...slugs).all();
  return result.results || [];
}

const productSnapshot = (product) => ({
  key: product.catalog_key,
  sku: product.sku,
  categoryId: product.category_id,
  brand: product.brand,
  nameRo: product.name_ro,
  price: Number(product.price),
  oldPrice: Number(product.old_price || 0),
  isActive: Boolean(product.is_active) && !product.deleted_at,
});

export async function onRequestPost(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context, ['manager', 'admin']);
    const request = normalizeRequest(await readBoundedJson(context.request, {
      maxBytes: MAX_IMPORT_JSON_BYTES,
      requireObject: true,
    }));

    const categoryIds = [...new Set(request.items.map((item) => item.draft.categoryId))];
    const categoryResult = await db.prepare(`
      SELECT id FROM categories
      WHERE is_active = 1 AND id IN (${placeholders(categoryIds.length)})
    `).bind(...categoryIds).all();
    const activeCategories = new Set((categoryResult.results || []).map((row) => row.id));
    const missingCategory = categoryIds.find((id) => !activeCategories.has(id));
    if (missingCategory) {
      return apiError('CATEGORY_NOT_FOUND', 'One or more mapped categories are unavailable', 409, { categoryId: missingCategory });
    }

    const existingRows = await loadExistingProducts(db, request.items);
    const existingBySku = new Map(existingRows.map((row) => [skuIdentity(row.sku), row]));
    for (const item of request.items) {
      const existing = existingBySku.get(item.identity);
      const collision = existingRows.find((row) => Number(row.id) !== Number(existing?.id)
        && (skuIdentity(row.catalog_key) === item.identity || String(row.slug).toLocaleLowerCase('en-US') === item.draft.slug));
      if (collision) {
        return apiError('PRODUCT_IMPORT_CONFLICT', 'A product code already belongs to another product URL', 409, {
          sheetRow: item.sheetRow,
          sku: item.draft.sku,
        });
      }
    }

    const now = new Date().toISOString();
    const ip = requestIp(context.request);
    const statements = [];
    const plans = [];
    for (const item of request.items) {
      const existing = existingBySku.get(item.identity);
      const draft = item.draft;
      if (!existing) {
        const revision = crypto.randomUUID();
        const primaryIndex = statements.length;
        statements.push(db.prepare(`
          INSERT INTO products (
            catalog_key, sku, slug, category_id, brand, name_ro, name_ru,
            description_ro, description_ru, price, old_price, cost_price, specs_json,
            is_active, is_featured, is_new, is_promo, is_summer, low_stock_threshold,
            source_type, admin_revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, 0, NULL, ?, ?, 0, 0, 0, 0, 2, 'admin', ?, ?, ?)
        `).bind(
          draft.catalogKey, draft.sku, draft.slug, draft.categoryId, draft.brand,
          draft.nameRo, draft.nameRu, draft.price, JSON.stringify(draft.specs),
          flag(draft.isActive), revision, now, now,
        ));
        statements.push(db.prepare(`
          INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, updated_at, admin_revision)
          SELECT id, 1, 0, 0, ?, ? FROM products WHERE catalog_key = ? AND admin_revision = ?
        `).bind(now, crypto.randomUUID(), draft.catalogKey, revision));
        const afterJson = JSON.stringify({
          importId: request.importId,
          sourceFile: request.sourceFile,
          sheetRow: item.sheetRow,
          ...productSnapshot({
            catalog_key: draft.catalogKey,
            sku: draft.sku,
            category_id: draft.categoryId,
            brand: draft.brand,
            name_ro: draft.nameRo,
            price: draft.price,
            old_price: 0,
            is_active: flag(draft.isActive),
            deleted_at: null,
          }),
        });
        statements.push(db.prepare(`
          INSERT INTO admin_audit_log (
            id, actor_user_id, action, entity_type, entity_id, before_json, after_json, request_ip, created_at
          )
          SELECT ?, ?, 'product.import_create', 'product', CAST(id AS TEXT), NULL, ?, ?, ?
          FROM products WHERE catalog_key = ? AND admin_revision = ?
        `).bind(`audit:${crypto.randomUUID()}`, user.id, afterJson, ip, now, draft.catalogKey, revision));
        plans.push({ action: 'created', sku: draft.sku, sheetRow: item.sheetRow, primaryIndex });
        continue;
      }

      const oldPrice = Number(existing.old_price || 0) >= draft.price ? Number(existing.old_price || 0) : 0;
      const before = productSnapshot(existing);
      const after = {
        ...before,
        categoryId: draft.categoryId,
        brand: draft.brand,
        nameRo: draft.nameRo,
        price: draft.price,
        oldPrice,
        isActive: draft.isActive,
      };
      if (JSON.stringify(before) === JSON.stringify(after)) {
        plans.push({ action: 'unchanged', sku: draft.sku, sheetRow: item.sheetRow, primaryIndex: -1 });
        continue;
      }
      const revision = crypto.randomUUID();
      const primaryIndex = statements.length;
      statements.push(db.prepare(`
        UPDATE products SET
          category_id = ?, brand = ?, name_ro = ?, price = ?, old_price = ?, is_active = ?,
          source_type = 'admin', admin_revision = ?, updated_at = ?,
          deleted_at = CASE WHEN ? = 1 THEN NULL ELSE deleted_at END
        WHERE id = ? AND COALESCE(admin_revision, '') = ?
      `).bind(
        draft.categoryId, draft.brand, draft.nameRo, draft.price, oldPrice, flag(draft.isActive),
        revision, now, flag(draft.isActive), existing.id, existing.admin_revision || '',
      ));
      statements.push(db.prepare(`
        INSERT INTO admin_audit_log (
          id, actor_user_id, action, entity_type, entity_id, before_json, after_json, request_ip, created_at
        )
        SELECT ?, ?, 'product.import_update', 'product', CAST(id AS TEXT), ?, ?, ?, ?
        FROM products WHERE id = ? AND admin_revision = ?
      `).bind(
        `audit:${crypto.randomUUID()}`, user.id, JSON.stringify(before), JSON.stringify({
          importId: request.importId,
          sourceFile: request.sourceFile,
          sheetRow: item.sheetRow,
          ...after,
        }), ip, now, existing.id, revision,
      ));
      plans.push({ action: 'updated', sku: draft.sku, sheetRow: item.sheetRow, primaryIndex });
    }

    let results = [];
    if (statements.length) {
      statements.push(catalogRevisionBump(db));
      results = await db.batch(statements);
    }
    const imported = plans.map((plan) => (
      plan.primaryIndex >= 0 && changedRows(results[plan.primaryIndex]) === 0
        ? { ...plan, action: 'failed', code: 'PRODUCT_REVISION_CONFLICT' }
        : plan
    ));
    const counts = imported.reduce((summary, item) => ({
      ...summary,
      [item.action]: summary[item.action] + 1,
    }), { created: 0, updated: 0, unchanged: 0, failed: 0 });
    return json({ ok: true, importId: request.importId, counts, items: imported }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return importError(error);
  }
}
