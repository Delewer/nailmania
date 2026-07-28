import { requireAdmin, requireSameOrigin } from '../../../_lib/admin-auth.js';
import {
  ADMIN_PROMO_SELECT,
  AdminPromoError,
  adminPromo,
  assertPromoScopes,
  getAdminPromo,
  normalizeAdminPromo,
  promoSnapshot,
} from '../../../_lib/admin-promos.js';
import { apiError, handleApiError, json } from '../../../_lib/http.js';
import { clampLikeTerm, likeContainsPattern } from '../../../_lib/search-pattern.js';

const requestIp = (request) => String(request.headers.get('cf-connecting-ip') || '').slice(0, 80);
const D1_MAX_BINDINGS = 100;

export function promoApiError(error) {
  if (error instanceof AdminPromoError) return apiError(error.code, error.message, error.status, error.details);
  const message = String(error?.message || error);
  if (/UNIQUE constraint failed: promo_codes.code/i.test(message)) {
    return apiError('PROMO_CODE_CONFLICT', 'Promo code already exists', 409);
  }
  if (/invalid promo code definition/i.test(message)) {
    return apiError('INVALID_PROMO_DEFINITION', 'Promo code definition is invalid', 400);
  }
  return handleApiError(error);
}

const scopeInsert = (db, table, column, promoId, values, now, guard = null) => {
  if (!values.length) return [];
  const guardBindings = guard || [];
  const fixedBindings = 2 + guardBindings.length;
  const chunkSize = D1_MAX_BINDINGS - fixedBindings;
  const where = guard ? `WHERE EXISTS (SELECT 1 FROM promo_codes WHERE id = ? AND admin_revision = ?)` : '';
  const statements = [];
  for (let offset = 0; offset < values.length; offset += chunkSize) {
    const valueChunk = values.slice(offset, offset + chunkSize);
    const rows = valueChunk.map(() => '(?)').join(', ');
    statements.push(db.prepare(`
      WITH scopes(value) AS (VALUES ${rows})
      INSERT INTO ${table} (promo_code_id, ${column}, created_at)
      SELECT ?, value, ? FROM scopes ${where}
    `).bind(...valueChunk, promoId, now, ...guardBindings));
  }
  return statements;
};

export async function onRequestGet(context) {
  try {
    const { db } = await requireAdmin(context, ['admin']);
    const url = new URL(context.request.url);
    const state = String(url.searchParams.get('state') || 'all').trim();
    const search = clampLikeTerm(url.searchParams.get('q'));
    if (!['all', 'active', 'inactive'].includes(state)) return apiError('INVALID_PROMO_STATE', 'Unknown promo state', 400);
    const conditions = [];
    const bindings = [];
    if (state === 'active') conditions.push('pc.is_active = 1');
    if (state === 'inactive') conditions.push('pc.is_active = 0');
    if (search) { conditions.push('pc.code LIKE ?'); bindings.push(likeContainsPattern(search.toUpperCase())); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [result, counts] = await Promise.all([
      db.prepare(`${ADMIN_PROMO_SELECT} ${where} ORDER BY pc.created_at DESC, pc.id DESC`).bind(...bindings).all(),
      db.prepare(`
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS inactive,
          (SELECT COUNT(*) FROM promo_redemptions WHERE released_at IS NULL) AS usage_count,
          (SELECT COALESCE(SUM(discount_amount), 0) FROM promo_redemptions WHERE released_at IS NULL) AS discount_sum
        FROM promo_codes
      `).first(),
    ]);
    return json({
      ok: true,
      items: (result.results || []).map(adminPromo),
      counts: {
        total: Number(counts?.total || 0),
        active: Number(counts?.active || 0),
        inactive: Number(counts?.inactive || 0),
        usageCount: Number(counts?.usage_count || 0),
        discountSum: Number(counts?.discount_sum || 0),
      },
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return promoApiError(error);
  }
}

export async function onRequestPost(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context, ['admin']);
    let body;
    try { body = await context.request.json(); }
    catch { return apiError('INVALID_JSON', 'Request body must be valid JSON', 400); }
    const draft = normalizeAdminPromo(body);
    await assertPromoScopes(db, draft);
    const id = crypto.randomUUID();
    const revision = crypto.randomUUID();
    const now = new Date().toISOString();
    const statements = [db.prepare(`
      INSERT INTO promo_codes (
        id, code, discount_type, discount_value, max_discount, min_order_amount,
        starts_at, ends_at, total_use_limit, per_user_limit, is_active,
        admin_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, draft.code, draft.discountType, draft.discountValue, draft.maxDiscount,
      draft.minOrderAmount, draft.startsAt, draft.endsAt, draft.totalUseLimit,
      draft.perUserLimit, draft.isActive ? 1 : 0, revision, now, now,
    )];
    statements.push(...scopeInsert(db, 'promo_code_categories', 'category_id', id, draft.categoryIds, now));
    statements.push(...scopeInsert(db, 'promo_code_products', 'product_id', id, draft.productIds, now));
    statements.push(db.prepare(`
      INSERT INTO admin_audit_log (
        id, actor_user_id, action, entity_type, entity_id, before_json, after_json, request_ip, created_at
      ) VALUES (?, ?, 'promo.create', 'promo_code', ?, NULL, ?, ?, ?)
    `).bind(
      `audit:${crypto.randomUUID()}`, user.id, id,
      JSON.stringify(promoSnapshot(draft)), requestIp(context.request), now,
    ));
    await db.batch(statements);
    return json({ ok: true, promo: await getAdminPromo(db, id) }, 201, { 'cache-control': 'no-store' });
  } catch (error) {
    return promoApiError(error);
  }
}

export { scopeInsert };
