import { requireAdmin, requireSameOrigin } from '../../../_lib/admin-auth.js';
import {
  AdminProductError,
  changedRows,
  getAdminProduct,
  normalizeAdminProduct,
  productSnapshot,
} from '../../../_lib/admin-products.js';
import { apiError, handleApiError, json } from '../../../_lib/http.js';
import { catalogRevisionBump } from '../../../_lib/catalog-cache.js';

const productId = (params) => decodeURIComponent(String(params.id || '')).trim().slice(0, 120);
const requestIp = (request) => String(request.headers.get('cf-connecting-ip') || '').slice(0, 80);
const flag = (value) => value ? 1 : 0;

function productError(error) {
  if (error instanceof AdminProductError) return apiError(error.code, error.message, error.status, error.details);
  if (/UNIQUE constraint failed/i.test(String(error?.message || error))) {
    return apiError('PRODUCT_CONFLICT', 'SKU or product URL already exists', 409);
  }
  return handleApiError(error);
}

export async function onRequestGet(context) {
  try {
    const { db } = await requireAdmin(context);
    const id = productId(context.params);
    if (!id) return apiError('INVALID_PRODUCT_ID', 'Product id is required', 400);
    const product = await getAdminProduct(db, id);
    if (!product) return apiError('PRODUCT_NOT_FOUND', 'Product not found', 404);
    return json({ ok: true, product }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return productError(error);
  }
}

export async function onRequestPatch(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context);
    const id = productId(context.params);
    if (!id) return apiError('INVALID_PRODUCT_ID', 'Product id is required', 400);
    let body;
    try { body = await context.request.json(); }
    catch { return apiError('INVALID_JSON', 'Request body must be valid JSON', 400); }
    if (!Object.hasOwn(body || {}, 'revision')) return apiError('PRODUCT_REVISION_REQUIRED', 'Product revision is required', 400);
    const expectedRevision = String(body.revision || '').slice(0, 120);
    const existing = await getAdminProduct(db, id);
    if (!existing) return apiError('PRODUCT_NOT_FOUND', 'Product not found', 404);
    const draft = normalizeAdminProduct(body, { current: existing });
    const retainedObjectKeys = new Set(draft.images.map((image) => image.objectKey).filter(Boolean));
    const removedObjectKeys = existing.images
      .map((image) => image.objectKey)
      .filter((key) => key?.startsWith('admin-') && !retainedObjectKeys.has(key));
    const category = await db.prepare('SELECT id FROM categories WHERE id = ? AND is_active = 1').bind(draft.categoryId).first();
    if (!category) return apiError('CATEGORY_NOT_FOUND', 'Active category not found', 409);
    const conflict = await db.prepare(`
      SELECT id FROM products WHERE id <> ? AND sku = ? COLLATE NOCASE LIMIT 1
    `).bind(existing.id, draft.sku).first();
    if (conflict) return apiError('PRODUCT_CONFLICT', 'SKU already belongs to another product', 409);

    const now = new Date().toISOString();
    const revision = crypto.randomUUID();
    const beforeJson = JSON.stringify(productSnapshot(existing));
    const afterJson = JSON.stringify({
      ...productSnapshot(existing),
      sku: draft.sku,
      categoryId: draft.categoryId,
      brand: draft.brand,
      nameRo: draft.nameRo,
      nameRu: draft.nameRu,
      price: draft.price,
      oldPrice: draft.oldPrice,
      costPrice: draft.costPrice,
      isActive: draft.isActive,
      isFeatured: draft.isFeatured,
      isNew: draft.isNew,
      isPromo: draft.isPromo,
      isSummer: draft.isSummer,
      lowStockThreshold: draft.lowStockThreshold,
      images: draft.images.map((image) => image.url),
    });
    const statements = [db.prepare(`
      UPDATE products SET
        sku = ?, category_id = ?, brand = ?, name_ro = ?, name_ru = ?,
        description_ro = ?, description_ru = ?, price = ?, old_price = ?, cost_price = ?,
        specs_json = ?, is_active = ?, is_featured = ?, is_new = ?, is_promo = ?, is_summer = ?,
        low_stock_threshold = ?, source_type = 'admin', admin_revision = ?, updated_at = ?,
        deleted_at = CASE WHEN ? = 1 THEN NULL ELSE deleted_at END
      WHERE id = ? AND COALESCE(admin_revision, '') = ?
    `).bind(
      draft.sku, draft.categoryId, draft.brand, draft.nameRo, draft.nameRu,
      draft.descriptionRo, draft.descriptionRu, draft.price, draft.oldPrice, draft.costPrice,
      JSON.stringify(draft.specs), flag(draft.isActive), flag(draft.isFeatured), flag(draft.isNew),
      flag(draft.isPromo), flag(draft.isSummer), draft.lowStockThreshold, revision, now,
      flag(draft.isActive), existing.id, expectedRevision,
    )];
    statements.push(db.prepare(`
      DELETE FROM product_images
      WHERE product_id = ? AND EXISTS (
        SELECT 1 FROM products WHERE id = ? AND admin_revision = ?
      )
    `).bind(existing.id, existing.id, revision));
    draft.images.forEach((image, index) => {
      statements.push(db.prepare(`
        INSERT INTO product_images (
          product_id, object_key, public_url, alt_ro, alt_ru, sort_order, is_primary, created_at
        )
        SELECT id, ?, ?, ?, ?, ?, ?, ? FROM products WHERE id = ? AND admin_revision = ?
      `).bind(image.objectKey, image.url, image.altRo, image.altRu, index, index === 0 ? 1 : 0, now, existing.id, revision));
    });
    statements.push(db.prepare(`
      INSERT INTO admin_audit_log (
        id, actor_user_id, action, entity_type, entity_id, before_json, after_json, request_ip, created_at
      )
      SELECT ?, ?, 'product.update', 'product', CAST(id AS TEXT), ?, ?, ?, ?
      FROM products WHERE id = ? AND admin_revision = ?
    `).bind(`audit:${crypto.randomUUID()}`, user.id, beforeJson, afterJson, requestIp(context.request), now, existing.id, revision));
    statements.push(catalogRevisionBump(
      db,
      'EXISTS (SELECT 1 FROM products WHERE id = ? AND admin_revision = ?)',
      [existing.id, revision],
    ));

    const results = await db.batch(statements);
    if (changedRows(results?.[0]) === 0) {
      return apiError('PRODUCT_REVISION_CONFLICT', 'Product was changed by another administrator', 409);
    }
    if (context.env.PRODUCT_IMAGES && removedObjectKeys.length) {
      for (const key of removedObjectKeys) {
        try {
          const reference = await db.prepare('SELECT COUNT(*) AS count FROM product_images WHERE object_key = ?').bind(key).first();
          if (Number(reference?.count || 0) === 0) await context.env.PRODUCT_IMAGES.delete(key);
        } catch (cleanupError) {
          console.error(cleanupError);
        }
      }
    }
    const product = await getAdminProduct(db, existing.id);
    return json({ ok: true, product }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return productError(error);
  }
}

export async function onRequestDelete(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context);
    const id = productId(context.params);
    if (!id) return apiError('INVALID_PRODUCT_ID', 'Product id is required', 400);
    let body;
    try { body = await context.request.json(); }
    catch { return apiError('INVALID_JSON', 'Request body must be valid JSON', 400); }
    if (!Object.hasOwn(body || {}, 'revision')) return apiError('PRODUCT_REVISION_REQUIRED', 'Product revision is required', 400);
    const expectedRevision = String(body.revision || '').slice(0, 120);
    const existing = await getAdminProduct(db, id);
    if (!existing) return apiError('PRODUCT_NOT_FOUND', 'Product not found', 404);
    if (existing.isDeleted) return json({ ok: true, changed: false, product: existing }, 200, { 'cache-control': 'no-store' });

    const now = new Date().toISOString();
    const revision = crypto.randomUUID();
    const beforeJson = JSON.stringify(productSnapshot(existing));
    const afterJson = JSON.stringify({ ...productSnapshot(existing), isActive: false, deletedAt: now });
    const results = await db.batch([
      db.prepare(`
        UPDATE products
        SET is_active = 0, deleted_at = ?, source_type = 'admin', admin_revision = ?, updated_at = ?
        WHERE id = ? AND COALESCE(admin_revision, '') = ?
      `).bind(now, revision, now, existing.id, expectedRevision),
      db.prepare(`
        INSERT INTO admin_audit_log (
          id, actor_user_id, action, entity_type, entity_id, before_json, after_json, request_ip, created_at
        )
        SELECT ?, ?, 'product.delete', 'product', CAST(id AS TEXT), ?, ?, ?, ?
        FROM products WHERE id = ? AND admin_revision = ?
      `).bind(`audit:${crypto.randomUUID()}`, user.id, beforeJson, afterJson, requestIp(context.request), now, existing.id, revision),
      catalogRevisionBump(
        db,
        'EXISTS (SELECT 1 FROM products WHERE id = ? AND admin_revision = ?)',
        [existing.id, revision],
      ),
    ]);
    if (changedRows(results?.[0]) === 0) {
      return apiError('PRODUCT_REVISION_CONFLICT', 'Product was changed by another administrator', 409);
    }
    const product = await getAdminProduct(db, existing.id);
    return json({ ok: true, changed: true, product }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return productError(error);
  }
}
