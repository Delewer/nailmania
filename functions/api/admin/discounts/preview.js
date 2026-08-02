import { requireAdmin, requireSameOrigin } from '../../../_lib/admin-auth.js';
import {
  AdminDiscountError,
  assertDiscountScopes,
  catalogScopeBindings,
  catalogScopeMatchSql,
  normalizeAdminDiscount,
} from '../../../_lib/admin-discounts.js';
import { json, readBoundedJson } from '../../../_lib/http.js';
import { discountApiError } from './index.js';

const MAX_ADMIN_BODY_BYTES = 32 * 1024;

const editingDiscount = async (db, body) => {
  if (body?.discountId === null || body?.discountId === undefined || body?.discountId === '') {
    return { id: '', revision: '' };
  }
  if (typeof body.discountId !== 'string' || !body.discountId.trim() || body.discountId.trim().length > 120) {
    throw new AdminDiscountError('INVALID_DISCOUNT_ID', 'Catalog discount id is invalid');
  }
  if (typeof body.revision !== 'string' || !body.revision || body.revision.length > 120) {
    throw new AdminDiscountError('DISCOUNT_REVISION_REQUIRED', 'Catalog discount revision is required');
  }
  const id = body.discountId.trim();
  const existing = await db.prepare(`
    SELECT admin_revision FROM catalog_discounts WHERE id = ? LIMIT 1
  `).bind(id).first();
  if (!existing) {
    throw new AdminDiscountError('DISCOUNT_NOT_FOUND', 'Catalog discount was not found', 404);
  }
  if (existing.admin_revision !== body.revision) {
    throw new AdminDiscountError(
      'DISCOUNT_REVISION_CONFLICT',
      'Catalog discount was changed by another user',
      409,
    );
  }
  return { id, revision: existing.admin_revision };
};

export async function onRequestPost(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db } = await requireAdmin(context);
    const body = await readBoundedJson(context.request, {
      maxBytes: MAX_ADMIN_BODY_BYTES,
      requireObject: true,
    });
    const editing = await editingDiscount(db, body);
    const draft = await assertDiscountScopes(db, normalizeAdminDiscount({
      ...body,
      name: String(body?.name || 'Preview'),
    }));
    const now = new Date().toISOString();
    const evaluatedAt = draft.startsAt && draft.startsAt > now ? draft.startsAt : now;
    const appliesAtEvaluation = draft.isActive
      && (!draft.startsAt || draft.startsAt <= evaluatedAt)
      && (!draft.endsAt || draft.endsAt > evaluatedAt);
    const match = catalogScopeMatchSql('product');
    const bindings = catalogScopeBindings(draft);
    const otherCampaignPercentage = `COALESCE((
      SELECT MAX(other.percentage)
      FROM catalog_discounts other
      WHERE other.id <> ?
        AND other.is_active = 1
        AND (other.starts_at IS NULL OR other.starts_at <= ?)
        AND (other.ends_at IS NULL OR other.ends_at > ?)
        AND (
          EXISTS (
            SELECT 1 FROM catalog_discount_products scope
            WHERE scope.catalog_discount_id = other.id AND scope.product_id = product.id
          )
          OR EXISTS (
            SELECT 1 FROM catalog_discount_categories scope
            WHERE scope.catalog_discount_id = other.id AND scope.category_id = product.category_id
          )
          OR EXISTS (
            SELECT 1 FROM catalog_discount_brands scope
            WHERE scope.catalog_discount_id = other.id AND scope.brand = product.brand COLLATE NOCASE
          )
        )
    ), 0)`;
    const hypotheticalPercentage = `MAX(${otherCampaignPercentage}, ?)`;
    const hypotheticalPrice = `MAX(0, product.price - CAST((product.price * ${hypotheticalPercentage} + 50) / 100 AS INTEGER))`;
    const [countRow, sampleResult] = await Promise.all([
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM products product
        WHERE product.is_active = 1 AND product.deleted_at IS NULL AND ${match}
      `).bind(...bindings).first(),
      db.prepare(`
        SELECT product.id, product.catalog_key, product.sku, product.name_ro,
               product.brand, product.price AS base_price,
               prices.effective_price AS current_price,
               ${hypotheticalPrice} AS preview_price
        FROM products product
        JOIN product_catalog_prices prices ON prices.product_id = product.id
        WHERE product.is_active = 1 AND product.deleted_at IS NULL AND ${match}
        ORDER BY product.name_ro, product.id
        LIMIT 12
      `).bind(
        editing.id,
        evaluatedAt,
        evaluatedAt,
        appliesAtEvaluation ? draft.percentage : 0,
        ...bindings,
      ).all(),
    ]);
    return json({
      ok: true,
      discountId: editing.id || null,
      revision: editing.revision || null,
      evaluatedAt,
      appliesAtEvaluation,
      affectedCount: Number(countRow?.count || 0),
      sample: (sampleResult.results || []).map((product) => ({
        id: Number(product.id),
        key: product.catalog_key,
        sku: product.sku,
        name: product.name_ro,
        brand: product.brand,
        basePrice: Number(product.base_price),
        currentPrice: Number(product.current_price),
        previewPrice: Number(product.preview_price),
      })),
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return discountApiError(error);
  }
}
