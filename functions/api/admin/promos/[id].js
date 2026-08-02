import { requireAdmin, requireSameOrigin } from '../../../_lib/admin-auth.js';
import {
  AdminPromoError,
  assertPromoScopes,
  getAdminPromo,
  normalizeAdminPromo,
  promoSnapshot,
} from '../../../_lib/admin-promos.js';
import { apiError, json } from '../../../_lib/http.js';
import { promoApiError, scopeInsert } from './index.js';

const promoId = (params) => {
  try { return decodeURIComponent(String(params?.id || '')).trim().slice(0, 120); }
  catch { throw new AdminPromoError('INVALID_PROMO_ID', 'Promo id is invalid'); }
};
const requestIp = (request) => String(request.headers.get('cf-connecting-ip') || '').slice(0, 80);
const changedRows = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

export async function onRequestGet(context) {
  try {
    const { db } = await requireAdmin(context, ['admin']);
    const id = promoId(context.params);
    if (!id) return apiError('INVALID_PROMO_ID', 'Promo id is required', 400);
    const promo = await getAdminPromo(db, id);
    if (!promo) return apiError('PROMO_NOT_FOUND', 'Promo code was not found', 404);
    return json({ ok: true, promo }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return promoApiError(error);
  }
}

export async function onRequestPatch(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context, ['admin']);
    const id = promoId(context.params);
    if (!id) return apiError('INVALID_PROMO_ID', 'Promo id is required', 400);
    let body;
    try { body = await context.request.json(); }
    catch { return apiError('INVALID_JSON', 'Request body must be valid JSON', 400); }
    if (!Object.hasOwn(body || {}, 'revision')) return apiError('PROMO_REVISION_REQUIRED', 'Promo revision is required', 400);
    const expectedRevision = String(body.revision || '').slice(0, 120);
    const existing = await getAdminPromo(db, id);
    if (!existing) return apiError('PROMO_NOT_FOUND', 'Promo code was not found', 404);
    const draft = normalizeAdminPromo(body, existing);
    await assertPromoScopes(db, draft);
    const revision = crypto.randomUUID();
    const now = new Date().toISOString();
    const beforeJson = JSON.stringify(promoSnapshot(existing));
    const afterJson = JSON.stringify(promoSnapshot(draft));
    const guard = [id, revision];
    const statements = [db.prepare(`
      UPDATE promo_codes SET
        code = ?, discount_type = ?, discount_value = ?, max_discount = ?,
        min_order_amount = ?, starts_at = ?, ends_at = ?, total_use_limit = ?,
        per_user_limit = ?, is_active = ?, admin_revision = ?, updated_at = ?
      WHERE id = ? AND COALESCE(admin_revision, '') = ?
    `).bind(
      draft.code, draft.discountType, draft.discountValue, draft.maxDiscount,
      draft.minOrderAmount, draft.startsAt, draft.endsAt, draft.totalUseLimit,
      draft.perUserLimit, draft.isActive ? 1 : 0, revision, now, id, expectedRevision,
    ), db.prepare(`
      DELETE FROM promo_code_categories
      WHERE promo_code_id = ?
        AND EXISTS (SELECT 1 FROM promo_codes WHERE id = ? AND admin_revision = ?)
    `).bind(id, ...guard), db.prepare(`
      DELETE FROM promo_code_products
      WHERE promo_code_id = ?
        AND EXISTS (SELECT 1 FROM promo_codes WHERE id = ? AND admin_revision = ?)
    `).bind(id, ...guard), db.prepare(`
      DELETE FROM promo_code_brands
      WHERE promo_code_id = ?
        AND EXISTS (SELECT 1 FROM promo_codes WHERE id = ? AND admin_revision = ?)
    `).bind(id, ...guard)];
    statements.push(...scopeInsert(db, 'promo_code_categories', 'category_id', id, draft.categoryIds, now, guard));
    statements.push(...scopeInsert(db, 'promo_code_products', 'product_id', id, draft.productIds, now, guard));
    statements.push(...scopeInsert(db, 'promo_code_brands', 'brand', id, draft.brands, now, guard));
    statements.push(db.prepare(`
      INSERT INTO admin_audit_log (
        id, actor_user_id, action, entity_type, entity_id, before_json, after_json, request_ip, created_at
      )
      SELECT ?, ?, 'promo.update', 'promo_code', id, ?, ?, ?, ?
      FROM promo_codes WHERE id = ? AND admin_revision = ?
    `).bind(
      `audit:${crypto.randomUUID()}`, user.id, beforeJson, afterJson,
      requestIp(context.request), now, id, revision,
    ));
    const results = await db.batch(statements);
    if (changedRows(results?.[0]) === 0) {
      return apiError('PROMO_REVISION_CONFLICT', 'Promo code was changed by another administrator', 409);
    }
    return json({ ok: true, promo: await getAdminPromo(db, id) }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return promoApiError(error);
  }
}

export async function onRequestDelete(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context, ['admin']);
    const id = promoId(context.params);
    if (!id) return apiError('INVALID_PROMO_ID', 'Promo id is required', 400);
    let body;
    try { body = await context.request.json(); }
    catch { return apiError('INVALID_JSON', 'Request body must be valid JSON', 400); }
    if (!Object.hasOwn(body || {}, 'revision')) return apiError('PROMO_REVISION_REQUIRED', 'Promo revision is required', 400);
    const expectedRevision = String(body.revision || '').slice(0, 120);
    const existing = await getAdminPromo(db, id);
    if (!existing) return apiError('PROMO_NOT_FOUND', 'Promo code was not found', 404);
    if (!existing.isActive) return json({ ok: true, changed: false, promo: existing }, 200, { 'cache-control': 'no-store' });
    const revision = crypto.randomUUID();
    const now = new Date().toISOString();
    const results = await db.batch([db.prepare(`
      UPDATE promo_codes SET is_active = 0, admin_revision = ?, updated_at = ?
      WHERE id = ? AND COALESCE(admin_revision, '') = ?
    `).bind(revision, now, id, expectedRevision), db.prepare(`
      INSERT INTO admin_audit_log (
        id, actor_user_id, action, entity_type, entity_id, before_json, after_json, request_ip, created_at
      )
      SELECT ?, ?, 'promo.deactivate', 'promo_code', id, ?, ?, ?, ?
      FROM promo_codes WHERE id = ? AND admin_revision = ?
    `).bind(
      `audit:${crypto.randomUUID()}`, user.id,
      JSON.stringify(promoSnapshot(existing)),
      JSON.stringify({ ...promoSnapshot(existing), isActive: false }),
      requestIp(context.request), now, id, revision,
    )]);
    if (changedRows(results?.[0]) === 0) {
      return apiError('PROMO_REVISION_CONFLICT', 'Promo code was changed by another administrator', 409);
    }
    return json({ ok: true, changed: true, promo: await getAdminPromo(db, id) }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return promoApiError(error);
  }
}
