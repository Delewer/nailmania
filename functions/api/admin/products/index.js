import { requireAdmin, requireSameOrigin } from '../../../_lib/admin-auth.js';
import {
  ADMIN_PRODUCT_SELECT,
  AdminProductError,
  adminProductSummary,
  getAdminProduct,
  normalizeAdminProduct,
} from '../../../_lib/admin-products.js';
import { apiError, handleApiError, json } from '../../../_lib/http.js';
import { catalogRevisionBump } from '../../../_lib/catalog-cache.js';
import { clampLikeTerm, likeContainsPattern } from '../../../_lib/search-pattern.js';

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
    const url = new URL(context.request.url);
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '30', 10)));
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10));
    const search = clampLikeTerm(url.searchParams.get('q'));
    const category = String(url.searchParams.get('category') || '').trim().slice(0, 100);
    const state = String(url.searchParams.get('state') || 'all').trim();
    const stock = String(url.searchParams.get('stock') || 'all').trim();
    if (!['all', 'active', 'inactive'].includes(state)) return apiError('INVALID_PRODUCT_STATE', 'Unknown product state', 400);
    if (!['all', 'out', 'low'].includes(stock)) return apiError('INVALID_STOCK_FILTER', 'Unknown stock filter', 400);

    const conditions = [];
    const bindings = [];
    if (search) {
      const pattern = likeContainsPattern(search);
      conditions.push('(p.name_ro LIKE ? OR p.name_ru LIKE ? OR p.brand LIKE ? OR p.sku LIKE ? OR p.catalog_key LIKE ?)');
      bindings.push(pattern, pattern, pattern, pattern, pattern);
    }
    if (category) { conditions.push('p.category_id = ?'); bindings.push(category); }
    if (state === 'active') conditions.push('p.is_active = 1 AND p.deleted_at IS NULL');
    if (state === 'inactive') conditions.push('(p.is_active = 0 OR p.deleted_at IS NOT NULL)');
    const availableExpression = 'MAX(0, COALESCE(i.on_hand, 0) - COALESCE(i.reserved, 0))';
    if (stock === 'out') conditions.push(`${availableExpression} = 0`);
    if (stock === 'low') conditions.push(`${availableExpression} > 0 AND ${availableExpression} <= p.low_stock_threshold`);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [productResult, countRow, summaryRow] = await Promise.all([
      db.prepare(`${ADMIN_PRODUCT_SELECT} ${where}
        ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?
      `).bind(...bindings, limit, offset).all(),
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM products p LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
        ${where}
      `).bind(...bindings).first(),
      db.prepare(`
        SELECT
          SUM(CASE WHEN is_active = 1 AND deleted_at IS NULL THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN is_active = 0 OR deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS inactive,
          SUM(CASE WHEN is_active = 1 AND deleted_at IS NULL AND available = 0 THEN 1 ELSE 0 END) AS out_of_stock,
          SUM(CASE WHEN is_active = 1 AND deleted_at IS NULL AND available > 0 AND available <= low_stock_threshold THEN 1 ELSE 0 END) AS low_stock
        FROM (
          SELECT p.is_active, p.deleted_at, p.low_stock_threshold,
                 MAX(0, COALESCE(i.on_hand, 0) - COALESCE(i.reserved, 0)) AS available
          FROM products p LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
        )
      `).first(),
    ]);

    return json({
      ok: true,
      items: (productResult.results || []).map(adminProductSummary),
      counts: {
        active: Number(summaryRow?.active || 0),
        inactive: Number(summaryRow?.inactive || 0),
        outOfStock: Number(summaryRow?.out_of_stock || 0),
        lowStock: Number(summaryRow?.low_stock || 0),
      },
      pagination: { limit, offset, total: Number(countRow?.count || 0) },
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return productError(error);
  }
}

export async function onRequestPost(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context);
    let body;
    try { body = await context.request.json(); }
    catch { return apiError('INVALID_JSON', 'Request body must be valid JSON', 400); }
    const draft = normalizeAdminProduct(body);
    const category = await db.prepare('SELECT id FROM categories WHERE id = ? AND is_active = 1').bind(draft.categoryId).first();
    if (!category) return apiError('CATEGORY_NOT_FOUND', 'Active category not found', 409);
    const conflict = await db.prepare(`
      SELECT id FROM products
      WHERE sku = ? COLLATE NOCASE OR catalog_key = ? COLLATE NOCASE OR slug = ? COLLATE NOCASE
      LIMIT 1
    `).bind(draft.sku, draft.catalogKey, draft.slug).first();
    if (conflict) return apiError('PRODUCT_CONFLICT', 'SKU or product URL already exists', 409);

    const now = new Date().toISOString();
    const revision = crypto.randomUUID();
    const inventoryRevision = crypto.randomUUID();
    const auditId = `audit:${crypto.randomUUID()}`;
    const statements = [db.prepare(`
      INSERT INTO products (
        catalog_key, sku, slug, category_id, brand, name_ro, name_ru,
        description_ro, description_ru, price, old_price, cost_price, specs_json,
        is_active, is_featured, is_new, is_promo, is_summer, low_stock_threshold,
        source_type, admin_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?, ?)
    `).bind(
      draft.catalogKey, draft.sku, draft.slug, draft.categoryId, draft.brand, draft.nameRo, draft.nameRu,
      draft.descriptionRo, draft.descriptionRu, draft.price, draft.oldPrice, draft.costPrice, JSON.stringify(draft.specs),
      flag(draft.isActive), flag(draft.isFeatured), flag(draft.isNew), flag(draft.isPromo), flag(draft.isSummer),
      draft.lowStockThreshold, revision, now, now,
    )];
    statements.push(db.prepare(`
      INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved, updated_at, admin_revision)
      SELECT id, 1, ?, 0, ?, ? FROM products WHERE catalog_key = ? AND admin_revision = ?
    `).bind(draft.initialStock, now, inventoryRevision, draft.catalogKey, revision));
    statements.push(db.prepare(`
      INSERT INTO inventory_movements (
        id, product_id, warehouse_id, movement_type, delta_on_hand, delta_reserved,
        balance_on_hand, balance_reserved, actor_user_id, reason, created_at
      )
      SELECT ?, id, 1, 'opening_balance', ?, 0, ?, 0, ?, 'Initial stock entered by administrator', ?
      FROM products WHERE catalog_key = ? AND admin_revision = ?
    `).bind(`opening:admin:${draft.catalogKey}`, draft.initialStock, draft.initialStock, user.id, now, draft.catalogKey, revision));
    draft.images.forEach((image, index) => {
      statements.push(db.prepare(`
        INSERT INTO product_images (
          product_id, object_key, public_url, alt_ro, alt_ru, sort_order, is_primary, created_at
        )
        SELECT id, ?, ?, ?, ?, ?, ?, ? FROM products WHERE catalog_key = ? AND admin_revision = ?
      `).bind(image.objectKey, image.url, image.altRo, image.altRu, index, index === 0 ? 1 : 0, now, draft.catalogKey, revision));
    });
    const afterJson = JSON.stringify({
      key: draft.catalogKey,
      sku: draft.sku,
      categoryId: draft.categoryId,
      nameRo: draft.nameRo,
      price: draft.price,
      isActive: draft.isActive,
      initialStock: draft.initialStock,
      images: draft.images.map((image) => image.url),
    });
    statements.push(db.prepare(`
      INSERT INTO admin_audit_log (
        id, actor_user_id, action, entity_type, entity_id, before_json, after_json, request_ip, created_at
      )
      SELECT ?, ?, 'product.create', 'product', CAST(id AS TEXT), NULL, ?, ?, ?
      FROM products WHERE catalog_key = ? AND admin_revision = ?
    `).bind(auditId, user.id, afterJson, requestIp(context.request), now, draft.catalogKey, revision));
    statements.push(catalogRevisionBump(db));
    await db.batch(statements);
    const product = await getAdminProduct(db, draft.catalogKey);
    return json({ ok: true, product }, 201, { 'cache-control': 'no-store' });
  } catch (error) {
    return productError(error);
  }
}
