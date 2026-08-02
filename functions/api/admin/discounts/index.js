import { requireAdmin, requireSameOrigin } from '../../../_lib/admin-auth.js';
import {
  ADMIN_DISCOUNT_SELECT,
  AdminDiscountError,
  adminDiscount,
  assertDiscountScopes,
  discountSnapshot,
  getAdminDiscount,
  normalizeAdminDiscount,
} from '../../../_lib/admin-discounts.js';
import { catalogRevisionBump } from '../../../_lib/catalog-cache.js';
import { apiError, handleApiError, json, readBoundedJson } from '../../../_lib/http.js';
import { clampLikeTerm, likeContainsPattern } from '../../../_lib/search-pattern.js';

const requestIp = (request) => String(request.headers.get('cf-connecting-ip') || '').slice(0, 80);
const D1_MAX_BINDINGS = 100;
const MAX_ADMIN_BODY_BYTES = 32 * 1024;

export function discountApiError(error) {
  if (error instanceof AdminDiscountError) return apiError(error.code, error.message, error.status, error.details);
  const message = String(error?.message || error);
  if (/invalid catalog discount definition/i.test(message)) {
    return apiError('INVALID_DISCOUNT_DEFINITION', 'Catalog discount definition is invalid', 400);
  }
  return handleApiError(error);
}

export const discountScopeInsert = (
  db,
  table,
  column,
  discountId,
  values,
  now,
  guard = null,
) => {
  if (!values.length) return [];
  const guardBindings = guard || [];
  const fixedBindings = 2 + guardBindings.length;
  const chunkSize = D1_MAX_BINDINGS - fixedBindings;
  const where = guard
    ? 'WHERE EXISTS (SELECT 1 FROM catalog_discounts WHERE id = ? AND admin_revision = ?)'
    : '';
  const statements = [];
  for (let offset = 0; offset < values.length; offset += chunkSize) {
    const valueChunk = values.slice(offset, offset + chunkSize);
    const rows = valueChunk.map(() => '(?)').join(', ');
    statements.push(db.prepare(`
      WITH scopes(value) AS (VALUES ${rows})
      INSERT INTO ${table} (catalog_discount_id, ${column}, created_at)
      SELECT ?, value, ? FROM scopes ${where}
    `).bind(...valueChunk, discountId, now, ...guardBindings));
  }
  return statements;
};

export async function onRequestGet(context) {
  try {
    const { db } = await requireAdmin(context);
    const url = new URL(context.request.url);
    const state = String(url.searchParams.get('state') || 'all').trim();
    const search = clampLikeTerm(url.searchParams.get('q'));
    if (!['all', 'active', 'inactive'].includes(state)) {
      return apiError('INVALID_DISCOUNT_STATE', 'Unknown catalog discount state', 400);
    }
    const conditions = [];
    const bindings = [];
    if (state === 'active') conditions.push('discount.is_active = 1');
    if (state === 'inactive') conditions.push('discount.is_active = 0');
    if (search) {
      conditions.push('discount.name LIKE ?');
      bindings.push(likeContainsPattern(search));
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [result, counts] = await Promise.all([
      db.prepare(`${ADMIN_DISCOUNT_SELECT} ${where}
        ORDER BY discount.created_at DESC, discount.id DESC
      `).bind(...bindings).all(),
      db.prepare(`
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS inactive
        FROM catalog_discounts
      `).first(),
    ]);
    return json({
      ok: true,
      items: (result.results || []).map(adminDiscount),
      counts: {
        total: Number(counts?.total || 0),
        active: Number(counts?.active || 0),
        inactive: Number(counts?.inactive || 0),
      },
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return discountApiError(error);
  }
}

export async function onRequestPost(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context);
    const body = await readBoundedJson(context.request, {
      maxBytes: MAX_ADMIN_BODY_BYTES,
      requireObject: true,
    });
    const draft = await assertDiscountScopes(db, normalizeAdminDiscount(body));
    const id = crypto.randomUUID();
    const revision = crypto.randomUUID();
    const now = new Date().toISOString();
    const statements = [db.prepare(`
      INSERT INTO catalog_discounts (
        id, name, percentage, starts_at, ends_at, is_active,
        admin_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, draft.name, draft.percentage, draft.startsAt, draft.endsAt,
      draft.isActive ? 1 : 0, revision, now, now,
    )];
    statements.push(...discountScopeInsert(
      db, 'catalog_discount_categories', 'category_id', id, draft.categoryIds, now,
    ));
    statements.push(...discountScopeInsert(
      db, 'catalog_discount_products', 'product_id', id, draft.productIds, now,
    ));
    statements.push(...discountScopeInsert(
      db, 'catalog_discount_brands', 'brand', id, draft.brands, now,
    ));
    statements.push(db.prepare(`
      INSERT INTO admin_audit_log (
        id, actor_user_id, action, entity_type, entity_id,
        before_json, after_json, request_ip, created_at
      ) VALUES (?, ?, 'catalog_discount.create', 'catalog_discount', ?, NULL, ?, ?, ?)
    `).bind(
      `audit:${crypto.randomUUID()}`, user.id, id,
      JSON.stringify(discountSnapshot(draft)), requestIp(context.request), now,
    ));
    statements.push(catalogRevisionBump(db));
    await db.batch(statements);
    return json({ ok: true, discount: await getAdminDiscount(db, id) }, 201, {
      'cache-control': 'no-store',
    });
  } catch (error) {
    return discountApiError(error);
  }
}
