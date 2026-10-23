import { requireAdmin, requireSameOrigin } from '../../../_lib/admin-auth.js';
import { AdminProductError, changedRows, normalizeAdminProduct } from '../../../_lib/admin-products.js';
import { catalogRevisionBump } from '../../../_lib/catalog-cache.js';
import { apiError, handleApiError, json, readBoundedJson } from '../../../_lib/http.js';

const MAX_IMPORT_ROWS = 25;
const MAX_IMPORT_JSON_BYTES = 512 * 1024;
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
    throw new AdminProductError('INVALID_PRODUCT_IMPORT', `Each import request must contain from 1 to ${MAX_IMPORT_ROWS} products`, 400);
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
    const stock = Number(item.stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000) {
      throw new AdminProductError('INVALID_PRODUCT_IMPORT', 'Stock must be an integer from 0 to 1000000', 400, { sheetRow });
    }
    const descriptionProvided = item.descriptionProvided === true;
    const imageProvided = item.imageProvided === true;
    const descriptionRo = descriptionProvided ? text(item.descriptionRo, 20_000) : '';
    const imageUrl = imageProvided ? text(item.imageUrl, 2048) : '';
    const draft = normalizeAdminProduct({
      sku: item.sku,
      categoryId: item.categoryId,
      brand: item.brand,
      nameRo: item.nameRo,
      nameRu: item.nameRo,
      descriptionRo,
      descriptionRu: descriptionRo,
      price: item.price,
      oldPrice: 0,
      costPrice: null,
      lowStockThreshold: 2,
      initialStock: stock,
      specs: item.specs || [],
      images: imageProvided && imageUrl ? [{ url: imageUrl, altRo: item.nameRo, altRu: item.nameRo }] : [],
      isActive: item.isActive,
      isFeatured: false,
      isNew: false,
      isPromo: false,
      isSummer: false,
    });
    const identity = skuIdentity(draft.sku);
    if (seen.has(identity)) {
      throw new AdminProductError('DUPLICATE_IMPORT_SKU', 'The same product code appears twice in one import batch', 400, { sheetRow, sku: draft.sku });
    }
    seen.add(identity);
    return { sheetRow, draft, identity, stock, descriptionProvided, imageProvided };
  });
  return { importId: importId.toLowerCase(), sourceFile, items };
}

async function loadExistingProducts(db, items) {
  const skus = items.map((item) => item.draft.sku);
  const slugs = items.map((item) => item.draft.slug);
  const marker = placeholders(items.length);
  const result = await db.prepare(`
    SELECT p.id, p.catalog_key, p.sku, p.slug, p.category_id, p.brand, p.name_ro, p.name_ru,
           p.description_ro, p.description_ru, p.price, p.old_price, p.is_active, p.deleted_at,
           p.admin_revision, COALESCE(i.on_hand, 0) AS on_hand, COALESCE(i.reserved, 0) AS reserved,
           COALESCE(i.admin_revision, '') AS inventory_revision,
           (SELECT public_url FROM product_images pi WHERE pi.product_id = p.id ORDER BY sort_order, id LIMIT 1) AS primary_image,
           (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id) AS image_count,
           (SELECT GROUP_CONCAT(object_key, char(31)) FROM product_images pi WHERE pi.product_id = p.id AND object_key LIKE 'admin-%') AS admin_image_keys
    FROM products p
    LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
    WHERE p.sku COLLATE NOCASE IN (${marker})
       OR p.catalog_key COLLATE NOCASE IN (${marker})
       OR p.slug COLLATE NOCASE IN (${marker})
  `).bind(...skus, ...skus, ...slugs).all();
  return result.results || [];
}

const productSnapshot = (product) => ({
  key: product.catalog_key,
  sku: product.sku,
  categoryId: product.category_id,
  brand: product.brand,
  nameRo: product.name_ro,
  descriptionRo: product.description_ro || '',
  price: Number(product.price),
  oldPrice: Number(product.old_price || 0),
  stock: Number(product.on_hand || 0),
  imageUrl: product.primary_image || '',
  isActive: Boolean(product.is_active) && !product.deleted_at,
});

const imageInsert = (db, selector, image, now, ...selectorBindings) => db.prepare(`
  INSERT INTO product_images (
    product_id, object_key, public_url, alt_ro, alt_ru, sort_order, is_primary, created_at
  ) SELECT id, ?, ?, ?, ?, 0, 1, ? FROM products WHERE ${selector}
`).bind(image.objectKey, image.url, image.altRo, image.altRu, now, ...selectorBindings);

export async function onRequestPost(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context, ['manager', 'admin']);
    const request = normalizeRequest(await readBoundedJson(context.request, {
      maxBytes: MAX_IMPORT_JSON_BYTES,
      requireObject: true,
    }));

    const categoryIds = [...new Set(request.items.map((item) => item.draft.categoryId))];
    const categoryResult = await db.prepare(`SELECT id FROM categories WHERE is_active = 1 AND id IN (${placeholders(categoryIds.length)})`)
      .bind(...categoryIds).all();
    const activeCategories = new Set((categoryResult.results || []).map((row) => row.id));
    const missingCategory = categoryIds.find((id) => !activeCategories.has(id));
    if (missingCategory) return apiError('CATEGORY_NOT_FOUND', 'One or more mapped categories are unavailable', 409, { categoryId: missingCategory });

    const existingRows = await loadExistingProducts(db, request.items);
    const existingBySku = new Map(existingRows.map((row) => [skuIdentity(row.sku), row]));
    for (const item of request.items) {
      const existing = existingBySku.get(item.identity);
      const collision = existingRows.find((row) => Number(row.id) !== Number(existing?.id)
        && (skuIdentity(row.catalog_key) === item.identity || String(row.slug).toLocaleLowerCase('en-US') === item.draft.slug));
      if (collision) return apiError('PRODUCT_IMPORT_CONFLICT', 'A product code already belongs to another product URL', 409, { sheetRow: item.sheetRow, sku: item.draft.sku });
      if (existing && item.stock < Number(existing.reserved || 0)) {
        return apiError('INVALID_PRODUCT_IMPORT_STOCK', 'Imported stock cannot be lower than reserved stock', 409, {
          sheetRow: item.sheetRow, sku: item.draft.sku, reserved: Number(existing.reserved || 0),
        });
      }
    }

    const now = new Date().toISOString();
    const ip = requestIp(context.request);
    const statements = [];
    const plans = [];
    const cleanupKeys = new Set();
    for (const item of request.items) {
      const existing = existingBySku.get(item.identity);
      const draft = item.draft;
      if (!existing) {
        const revision = crypto.randomUUID();
        const inventoryRevision = crypto.randomUUID();
        const primaryIndex = statements.length;
        statements.push(db.prepare(`
          INSERT INTO products (
            catalog_key, sku, slug, category_id, brand, name_ro, name_ru,
            description_ro, description_ru, price, old_price, cost_price, specs_json,
            is_active, is_featured, is_new, is_promo, is_summer, low_stock_threshold,
            source_type, admin_revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, 0, 0, 0, 0, 2, 'admin', ?, ?, ?)
        `).bind(
          draft.catalogKey, draft.sku, draft.slug, draft.categoryId, draft.brand, draft.nameRo, draft.nameRu,
          draft.descriptionRo, draft.descriptionRu, draft.price, JSON.stringify(draft.specs),
          flag(draft.isActive), revision, now, now,
        ));
        statements.push(db.prepare(`
          INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, updated_at, admin_revision)
          SELECT id, 1, ?, 0, ?, ? FROM products WHERE catalog_key = ? AND admin_revision = ?
        `).bind(item.stock, now, inventoryRevision, draft.catalogKey, revision));
        statements.push(db.prepare(`
          INSERT INTO inventory_movements (
            id, product_id, warehouse_id, movement_type, delta_on_hand, delta_reserved,
            balance_on_hand, balance_reserved, actor_user_id, reason, created_at
          ) SELECT ?, id, 1, 'opening_balance', ?, 0, ?, 0, ?, ?, ?
            FROM products WHERE catalog_key = ? AND admin_revision = ?
        `).bind(
          `opening:import:${crypto.randomUUID()}`, item.stock, item.stock, user.id,
          `Excel import: ${request.sourceFile}`, now, draft.catalogKey, revision,
        ));
        if (draft.images[0]) statements.push(imageInsert(
          db, 'catalog_key = ? AND admin_revision = ?', draft.images[0], now, draft.catalogKey, revision,
        ));
        const after = {
          importId: request.importId, sourceFile: request.sourceFile, sheetRow: item.sheetRow,
          key: draft.catalogKey, sku: draft.sku, categoryId: draft.categoryId, brand: draft.brand,
          nameRo: draft.nameRo, descriptionRo: draft.descriptionRo, price: draft.price,
          stock: item.stock, imageUrl: draft.images[0]?.url || '', isActive: draft.isActive,
        };
        statements.push(db.prepare(`
          INSERT INTO admin_audit_log (
            id, actor_user_id, action, entity_type, entity_id, before_json, after_json, request_ip, created_at
          ) SELECT ?, ?, 'product.import_create', 'product', CAST(id AS TEXT), NULL, ?, ?, ?
            FROM products WHERE catalog_key = ? AND admin_revision = ?
        `).bind(`audit:${crypto.randomUUID()}`, user.id, JSON.stringify(after), ip, now, draft.catalogKey, revision));
        plans.push({ action: 'created', sku: draft.sku, sheetRow: item.sheetRow, primaryIndex, inventoryIndex: -1 });
        continue;
      }

      const before = productSnapshot(existing);
      const oldPrice = Number(existing.old_price || 0) >= draft.price ? Number(existing.old_price || 0) : 0;
      const after = {
        ...before,
        categoryId: draft.categoryId,
        brand: draft.brand,
        nameRo: draft.nameRo,
        descriptionRo: item.descriptionProvided ? draft.descriptionRo : before.descriptionRo,
        price: draft.price,
        oldPrice,
        stock: item.stock,
        imageUrl: item.imageProvided ? (draft.images[0]?.url || '') : before.imageUrl,
        isActive: draft.isActive,
      };
      const replaceImages = item.imageProvided
        && (before.imageUrl !== after.imageUrl || Number(existing.image_count || 0) !== (draft.images[0] ? 1 : 0));
      if (JSON.stringify(before) === JSON.stringify(after) && !replaceImages) {
        plans.push({ action: 'unchanged', sku: draft.sku, sheetRow: item.sheetRow, primaryIndex: -1, inventoryIndex: -1 });
        continue;
      }

      const revision = crypto.randomUUID();
      const stockChanged = Number(existing.on_hand || 0) !== item.stock;
      const primaryIndex = statements.length;
      statements.push(db.prepare(`
        UPDATE products SET
          category_id = ?, brand = ?, name_ro = ?,
          description_ro = CASE WHEN ? = 1 THEN ? ELSE description_ro END,
          description_ru = CASE WHEN ? = 1 THEN ? ELSE description_ru END,
          price = ?, old_price = ?, is_active = ?, source_type = 'admin', admin_revision = ?, updated_at = ?,
          deleted_at = CASE WHEN ? = 1 THEN NULL ELSE deleted_at END
        WHERE id = ? AND COALESCE(admin_revision, '') = ?
          AND (? = 0 OR EXISTS (
            SELECT 1 FROM inventory i
            WHERE i.product_id = products.id AND i.warehouse_id = 1
              AND COALESCE(i.admin_revision, '') = ?
          ))
      `).bind(
        draft.categoryId, draft.brand, draft.nameRo,
        flag(item.descriptionProvided), draft.descriptionRo, flag(item.descriptionProvided), draft.descriptionRu,
        draft.price, oldPrice, flag(draft.isActive), revision, now, flag(draft.isActive),
        existing.id, existing.admin_revision || '', flag(stockChanged), existing.inventory_revision || '',
      ));
      let inventoryIndex = -1;
      if (stockChanged) {
        const inventoryRevision = crypto.randomUUID();
        inventoryIndex = statements.length;
        statements.push(db.prepare(`
          UPDATE inventory SET on_hand = ?, updated_at = ?, admin_revision = ?
          WHERE product_id = ? AND warehouse_id = 1 AND COALESCE(admin_revision, '') = ?
            AND EXISTS (SELECT 1 FROM products WHERE id = ? AND admin_revision = ?)
        `).bind(
          item.stock, now, inventoryRevision, existing.id, existing.inventory_revision || '', existing.id, revision,
        ));
        statements.push(db.prepare(`
          INSERT INTO inventory_movements (
            id, product_id, warehouse_id, movement_type, delta_on_hand, delta_reserved,
            balance_on_hand, balance_reserved, actor_user_id, reason, created_at
          ) SELECT ?, product_id, warehouse_id, 'adjustment', ?, 0, on_hand, reserved, ?, ?, ?
            FROM inventory WHERE product_id = ? AND warehouse_id = 1 AND admin_revision = ?
        `).bind(
          `stock:import:${crypto.randomUUID()}`, item.stock - Number(existing.on_hand || 0), user.id,
          `Excel import: ${request.sourceFile}`, now, existing.id, inventoryRevision,
        ));
      }
      if (replaceImages) {
        statements.push(db.prepare(`
          DELETE FROM product_images
          WHERE product_id = ? AND EXISTS (
            SELECT 1 FROM products WHERE id = ? AND admin_revision = ?
          )
        `).bind(existing.id, existing.id, revision));
        if (draft.images[0]) statements.push(imageInsert(
          db, 'id = ? AND admin_revision = ?', draft.images[0], now, existing.id, revision,
        ));
        for (const key of String(existing.admin_image_keys || '').split(String.fromCharCode(31)).filter(Boolean)) cleanupKeys.add(key);
      }
      statements.push(db.prepare(`
        INSERT INTO admin_audit_log (
          id, actor_user_id, action, entity_type, entity_id, before_json, after_json, request_ip, created_at
        ) SELECT ?, ?, 'product.import_update', 'product', CAST(id AS TEXT), ?, ?, ?, ?
          FROM products WHERE id = ? AND admin_revision = ?
      `).bind(
        `audit:${crypto.randomUUID()}`, user.id, JSON.stringify(before), JSON.stringify({
          importId: request.importId, sourceFile: request.sourceFile, sheetRow: item.sheetRow, ...after,
        }), ip, now, existing.id, revision,
      ));
      plans.push({ action: 'updated', sku: draft.sku, sheetRow: item.sheetRow, primaryIndex, inventoryIndex });
    }

    let results = [];
    if (statements.length) {
      statements.push(catalogRevisionBump(db));
      results = await db.batch(statements);
    }
    const imported = plans.map((plan) => (
      (plan.primaryIndex >= 0 && changedRows(results[plan.primaryIndex]) === 0)
      || (plan.inventoryIndex >= 0 && changedRows(results[plan.inventoryIndex]) === 0)
        ? { ...plan, action: 'failed', code: 'PRODUCT_REVISION_CONFLICT' }
        : plan
    ));
    if (context.env.PRODUCT_IMAGES && cleanupKeys.size) {
      for (const key of cleanupKeys) {
        try {
          const reference = await db.prepare(`
            SELECT ((SELECT COUNT(*) FROM product_images WHERE object_key = ?) + (SELECT COUNT(*) FROM categories WHERE image_object_key = ?)) AS count
          `).bind(key, key).first();
          if (Number(reference?.count || 0) === 0) await context.env.PRODUCT_IMAGES.delete(key);
        } catch (cleanupError) { console.error(cleanupError); }
      }
    }
    const counts = imported.reduce((summary, item) => ({
      ...summary, [item.action]: summary[item.action] + 1,
    }), { created: 0, updated: 0, unchanged: 0, failed: 0 });
    return json({ ok: true, importId: request.importId, counts, items: imported }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return importError(error);
  }
}
