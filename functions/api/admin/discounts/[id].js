import { requireAdmin, requireSameOrigin } from '../../../_lib/admin-auth.js';
import {
  AdminDiscountError,
  assertDiscountScopes,
  changedRows,
  discountSnapshot,
  getAdminDiscount,
  normalizeAdminDiscount,
} from '../../../_lib/admin-discounts.js';
import { catalogRevisionBump } from '../../../_lib/catalog-cache.js';
import { apiError, json, readBoundedJson } from '../../../_lib/http.js';
import { discountApiError, discountScopeInsert } from './index.js';

const discountId = (params) => {
  try { return decodeURIComponent(String(params?.id || '')).trim().slice(0, 120); }
  catch { throw new AdminDiscountError('INVALID_DISCOUNT_ID', 'Catalog discount id is invalid'); }
};
const requestIp = (request) => String(request.headers.get('cf-connecting-ip') || '').slice(0, 80);
const MAX_ADMIN_BODY_BYTES = 32 * 1024;

export async function onRequestGet(context) {
  try {
    const { db } = await requireAdmin(context);
    const id = discountId(context.params);
    if (!id) return apiError('INVALID_DISCOUNT_ID', 'Catalog discount id is required', 400);
    const discount = await getAdminDiscount(db, id);
    if (!discount) return apiError('DISCOUNT_NOT_FOUND', 'Catalog discount was not found', 404);
    return json({ ok: true, discount }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return discountApiError(error);
  }
}

export async function onRequestPatch(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context);
    const id = discountId(context.params);
    if (!id) return apiError('INVALID_DISCOUNT_ID', 'Catalog discount id is required', 400);
    const body = await readBoundedJson(context.request, {
      maxBytes: MAX_ADMIN_BODY_BYTES,
      requireObject: true,
    });
    if (!Object.hasOwn(body || {}, 'revision')) {
      return apiError('DISCOUNT_REVISION_REQUIRED', 'Catalog discount revision is required', 400);
    }
    const expectedRevision = String(body.revision || '').slice(0, 120);
    const existing = await getAdminDiscount(db, id);
    if (!existing) return apiError('DISCOUNT_NOT_FOUND', 'Catalog discount was not found', 404);
    const draft = await assertDiscountScopes(db, normalizeAdminDiscount(body, existing));
    const revision = crypto.randomUUID();
    const now = new Date().toISOString();
    const guard = [id, revision];
    const statements = [db.prepare(`
      UPDATE catalog_discounts SET
        name = ?, percentage = ?, starts_at = ?, ends_at = ?,
        is_active = ?, admin_revision = ?, updated_at = ?
      WHERE id = ? AND admin_revision = ?
    `).bind(
      draft.name, draft.percentage, draft.startsAt, draft.endsAt,
      draft.isActive ? 1 : 0, revision, now, id, expectedRevision,
    ), db.prepare(`
      DELETE FROM catalog_discount_categories
      WHERE catalog_discount_id = ?
        AND EXISTS (SELECT 1 FROM catalog_discounts WHERE id = ? AND admin_revision = ?)
    `).bind(id, ...guard), db.prepare(`
      DELETE FROM catalog_discount_products
      WHERE catalog_discount_id = ?
        AND EXISTS (SELECT 1 FROM catalog_discounts WHERE id = ? AND admin_revision = ?)
    `).bind(id, ...guard), db.prepare(`
      DELETE FROM catalog_discount_brands
      WHERE catalog_discount_id = ?
        AND EXISTS (SELECT 1 FROM catalog_discounts WHERE id = ? AND admin_revision = ?)
    `).bind(id, ...guard)];
    statements.push(...discountScopeInsert(
      db, 'catalog_discount_categories', 'category_id', id, draft.categoryIds, now, guard,
    ));
    statements.push(...discountScopeInsert(
      db, 'catalog_discount_products', 'product_id', id, draft.productIds, now, guard,
    ));
    statements.push(...discountScopeInsert(
      db, 'catalog_discount_brands', 'brand', id, draft.brands, now, guard,
    ));
    statements.push(db.prepare(`
      INSERT INTO admin_audit_log (
        id, actor_user_id, action, entity_type, entity_id,
        before_json, after_json, request_ip, created_at
      )
      SELECT ?, ?, 'catalog_discount.update', 'catalog_discount', id, ?, ?, ?, ?
      FROM catalog_discounts WHERE id = ? AND admin_revision = ?
    `).bind(
      `audit:${crypto.randomUUID()}`, user.id,
      JSON.stringify(discountSnapshot(existing)), JSON.stringify(discountSnapshot(draft)),
      requestIp(context.request), now, id, revision,
    ));
    statements.push(catalogRevisionBump(
      db,
      'EXISTS (SELECT 1 FROM catalog_discounts WHERE id = ? AND admin_revision = ?)',
      [id, revision],
    ));
    const results = await db.batch(statements);
    if (changedRows(results?.[0]) === 0) {
      return apiError('DISCOUNT_REVISION_CONFLICT', 'Catalog discount was changed by another user', 409);
    }
    return json({ ok: true, discount: await getAdminDiscount(db, id) }, 200, {
      'cache-control': 'no-store',
    });
  } catch (error) {
    return discountApiError(error);
  }
}

export async function onRequestDelete(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context);
    const id = discountId(context.params);
    if (!id) return apiError('INVALID_DISCOUNT_ID', 'Catalog discount id is required', 400);
    const body = await readBoundedJson(context.request, {
      maxBytes: MAX_ADMIN_BODY_BYTES,
      requireObject: true,
    });
    if (!Object.hasOwn(body || {}, 'revision')) {
      return apiError('DISCOUNT_REVISION_REQUIRED', 'Catalog discount revision is required', 400);
    }
    const expectedRevision = String(body.revision || '').slice(0, 120);
    const existing = await getAdminDiscount(db, id);
    if (!existing) return apiError('DISCOUNT_NOT_FOUND', 'Catalog discount was not found', 404);
    if (!existing.isActive) {
      return json({ ok: true, changed: false, discount: existing }, 200, { 'cache-control': 'no-store' });
    }
    const revision = crypto.randomUUID();
    const now = new Date().toISOString();
    const results = await db.batch([db.prepare(`
      UPDATE catalog_discounts
      SET is_active = 0, admin_revision = ?, updated_at = ?
      WHERE id = ? AND admin_revision = ?
    `).bind(revision, now, id, expectedRevision), db.prepare(`
      INSERT INTO admin_audit_log (
        id, actor_user_id, action, entity_type, entity_id,
        before_json, after_json, request_ip, created_at
      )
      SELECT ?, ?, 'catalog_discount.deactivate', 'catalog_discount', id, ?, ?, ?, ?
      FROM catalog_discounts WHERE id = ? AND admin_revision = ?
    `).bind(
      `audit:${crypto.randomUUID()}`, user.id,
      JSON.stringify(discountSnapshot(existing)),
      JSON.stringify({ ...discountSnapshot(existing), isActive: false }),
      requestIp(context.request), now, id, revision,
    ), catalogRevisionBump(
      db,
      'EXISTS (SELECT 1 FROM catalog_discounts WHERE id = ? AND admin_revision = ?)',
      [id, revision],
    )]);
    if (changedRows(results?.[0]) === 0) {
      return apiError('DISCOUNT_REVISION_CONFLICT', 'Catalog discount was changed by another user', 409);
    }
    return json({ ok: true, changed: true, discount: await getAdminDiscount(db, id) }, 200, {
      'cache-control': 'no-store',
    });
  } catch (error) {
    return discountApiError(error);
  }
}
