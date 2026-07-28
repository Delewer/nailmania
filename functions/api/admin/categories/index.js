import { requireAdmin, requireSameOrigin } from '../../../_lib/admin-auth.js';
import {
  ADMIN_CATEGORY_SELECT,
  AdminCategoryError,
  adminCategory,
  getAdminCategory,
  normalizeAdminCategory,
} from '../../../_lib/admin-categories.js';
import { apiError, handleApiError, json } from '../../../_lib/http.js';
import { catalogRevisionBump } from '../../../_lib/catalog-cache.js';
import { clampLikeTerm, likeContainsPattern } from '../../../_lib/search-pattern.js';

const requestIp = (request) => String(request.headers.get('cf-connecting-ip') || '').slice(0, 80);

function categoryError(error) {
  if (error instanceof AdminCategoryError) return apiError(error.code, error.message, error.status, error.details);
  if (/UNIQUE constraint failed/i.test(String(error?.message || error))) {
    return apiError('CATEGORY_CONFLICT', 'Category URL key already exists', 409);
  }
  return handleApiError(error);
}

export async function onRequestGet(context) {
  try {
    const { db } = await requireAdmin(context);
    const url = new URL(context.request.url);
    const search = clampLikeTerm(url.searchParams.get('q'));
    const state = String(url.searchParams.get('state') || 'all').trim();
    if (!['all', 'active', 'inactive'].includes(state)) return apiError('INVALID_CATEGORY_STATE', 'Unknown category state', 400);
    const conditions = [];
    const bindings = [];
    if (search) {
      const pattern = likeContainsPattern(search);
      conditions.push('(c.name_ro LIKE ? OR c.name_ru LIKE ? OR c.id LIKE ? OR c.slug LIKE ?)');
      bindings.push(pattern, pattern, pattern, pattern);
    }
    if (state === 'active') conditions.push('c.is_active = 1');
    if (state === 'inactive') conditions.push('c.is_active = 0');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [result, counts] = await Promise.all([
      db.prepare(`${ADMIN_CATEGORY_SELECT}
        ${where}
        GROUP BY c.id
        ORDER BY c.sort_order, c.name_ro
      `).bind(...bindings).all(),
      db.prepare(`
        SELECT
          SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS inactive,
          COUNT(*) AS total
        FROM categories
      `).first(),
    ]);
    return json({
      ok: true,
      items: (result.results || []).map(adminCategory),
      counts: {
        active: Number(counts?.active || 0),
        inactive: Number(counts?.inactive || 0),
        total: Number(counts?.total || 0),
      },
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return categoryError(error);
  }
}

export async function onRequestPost(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context);
    let body;
    try { body = await context.request.json(); }
    catch { return apiError('INVALID_JSON', 'Request body must be valid JSON', 400); }
    const orderRow = await db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM categories').first();
    const draft = normalizeAdminCategory(body, { defaultSortOrder: Number(orderRow?.next_order || 0) });
    const conflict = await db.prepare(`
      SELECT id FROM categories WHERE id = ? COLLATE NOCASE OR slug = ? COLLATE NOCASE LIMIT 1
    `).bind(draft.id, draft.slug).first();
    if (conflict) return apiError('CATEGORY_CONFLICT', 'Category URL key already exists', 409);

    const now = new Date().toISOString();
    const revision = crypto.randomUUID();
    const afterJson = JSON.stringify({ ...draft, revision: undefined });
    await db.batch([
      db.prepare(`
        INSERT INTO categories (
          id, slug, name_ro, name_ru, sort_order, is_active,
          seo_title_ro, seo_title_ru, seo_description_ro, seo_description_ru,
          source_type, admin_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?, ?)
      `).bind(
        draft.id, draft.slug, draft.nameRo, draft.nameRu, draft.sortOrder, draft.isActive ? 1 : 0,
        draft.seoTitleRo, draft.seoTitleRu, draft.seoDescriptionRo, draft.seoDescriptionRu,
        revision, now, now,
      ),
      db.prepare(`
        INSERT INTO admin_audit_log (
          id, actor_user_id, action, entity_type, entity_id, before_json, after_json, request_ip, created_at
        ) VALUES (?, ?, 'category.create', 'category', ?, NULL, ?, ?, ?)
      `).bind(`audit:${crypto.randomUUID()}`, user.id, draft.id, afterJson, requestIp(context.request), now),
      catalogRevisionBump(db),
    ]);
    return json({ ok: true, category: await getAdminCategory(db, draft.id) }, 201, { 'cache-control': 'no-store' });
  } catch (error) {
    return categoryError(error);
  }
}
