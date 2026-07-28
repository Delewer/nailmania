import { requireAdmin, requireSameOrigin } from '../../../_lib/admin-auth.js';
import {
  AdminCategoryError,
  categorySnapshot,
  changedRows,
  getAdminCategory,
  normalizeAdminCategory,
} from '../../../_lib/admin-categories.js';
import { apiError, handleApiError, json } from '../../../_lib/http.js';
import { catalogRevisionBump } from '../../../_lib/catalog-cache.js';

const categoryId = (params) => decodeURIComponent(String(params.id || '')).trim().slice(0, 100);
const requestIp = (request) => String(request.headers.get('cf-connecting-ip') || '').slice(0, 80);

function categoryError(error) {
  if (error instanceof AdminCategoryError) return apiError(error.code, error.message, error.status, error.details);
  return handleApiError(error);
}

export async function onRequestGet(context) {
  try {
    const { db } = await requireAdmin(context);
    const id = categoryId(context.params);
    if (!id) return apiError('INVALID_CATEGORY_ID', 'Category id is required', 400);
    const category = await getAdminCategory(db, id);
    if (!category) return apiError('CATEGORY_NOT_FOUND', 'Category not found', 404);
    return json({ ok: true, category }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return categoryError(error);
  }
}

export async function onRequestPatch(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context);
    const id = categoryId(context.params);
    if (!id) return apiError('INVALID_CATEGORY_ID', 'Category id is required', 400);
    let body;
    try { body = await context.request.json(); }
    catch { return apiError('INVALID_JSON', 'Request body must be valid JSON', 400); }
    if (!Object.hasOwn(body || {}, 'revision')) return apiError('CATEGORY_REVISION_REQUIRED', 'Category revision is required', 400);
    const expectedRevision = String(body.revision || '').slice(0, 120);
    const existing = await getAdminCategory(db, id);
    if (!existing) return apiError('CATEGORY_NOT_FOUND', 'Category not found', 404);
    const draft = normalizeAdminCategory(body, { current: existing });
    if (!draft.isActive && existing.productCount > 0) {
      return apiError('CATEGORY_IN_USE', 'Move all products before deactivating this category', 409, { productCount: existing.productCount });
    }

    const now = new Date().toISOString();
    const revision = crypto.randomUUID();
    const beforeJson = JSON.stringify(categorySnapshot(existing));
    const afterJson = JSON.stringify({ ...categorySnapshot(existing), ...draft });
    const results = await db.batch([
      db.prepare(`
        UPDATE categories SET
          name_ro = ?, name_ru = ?, sort_order = ?, is_active = ?,
          seo_title_ro = ?, seo_title_ru = ?, seo_description_ro = ?, seo_description_ru = ?,
          source_type = 'admin', admin_revision = ?, updated_at = ?
        WHERE id = ? AND COALESCE(admin_revision, '') = ?
      `).bind(
        draft.nameRo, draft.nameRu, draft.sortOrder, draft.isActive ? 1 : 0,
        draft.seoTitleRo, draft.seoTitleRu, draft.seoDescriptionRo, draft.seoDescriptionRu,
        revision, now, existing.id, expectedRevision,
      ),
      db.prepare(`
        INSERT INTO admin_audit_log (
          id, actor_user_id, action, entity_type, entity_id, before_json, after_json, request_ip, created_at
        )
        SELECT ?, ?, 'category.update', 'category', id, ?, ?, ?, ?
        FROM categories WHERE id = ? AND admin_revision = ?
      `).bind(
        `audit:${crypto.randomUUID()}`, user.id, beforeJson, afterJson,
        requestIp(context.request), now, existing.id, revision,
      ),
      catalogRevisionBump(
        db,
        'EXISTS (SELECT 1 FROM categories WHERE id = ? AND admin_revision = ?)',
        [existing.id, revision],
      ),
    ]);
    if (changedRows(results?.[0]) === 0) {
      return apiError('CATEGORY_REVISION_CONFLICT', 'Category was changed by another administrator', 409);
    }
    return json({ ok: true, category: await getAdminCategory(db, existing.id) }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return categoryError(error);
  }
}

export async function onRequestDelete(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context);
    const id = categoryId(context.params);
    if (!id) return apiError('INVALID_CATEGORY_ID', 'Category id is required', 400);
    let body;
    try { body = await context.request.json(); }
    catch { return apiError('INVALID_JSON', 'Request body must be valid JSON', 400); }
    if (!Object.hasOwn(body || {}, 'revision')) return apiError('CATEGORY_REVISION_REQUIRED', 'Category revision is required', 400);
    const expectedRevision = String(body.revision || '').slice(0, 120);
    const existing = await getAdminCategory(db, id);
    if (!existing) return apiError('CATEGORY_NOT_FOUND', 'Category not found', 404);
    if (!existing.isActive) return json({ ok: true, changed: false, category: existing }, 200, { 'cache-control': 'no-store' });
    if (existing.productCount > 0) {
      return apiError('CATEGORY_IN_USE', 'Move all products before deactivating this category', 409, { productCount: existing.productCount });
    }

    const now = new Date().toISOString();
    const revision = crypto.randomUUID();
    const beforeJson = JSON.stringify(categorySnapshot(existing));
    const afterJson = JSON.stringify({ ...categorySnapshot(existing), isActive: false });
    const results = await db.batch([
      db.prepare(`
        UPDATE categories SET is_active = 0, source_type = 'admin', admin_revision = ?, updated_at = ?
        WHERE id = ? AND COALESCE(admin_revision, '') = ?
      `).bind(revision, now, existing.id, expectedRevision),
      db.prepare(`
        INSERT INTO admin_audit_log (
          id, actor_user_id, action, entity_type, entity_id, before_json, after_json, request_ip, created_at
        )
        SELECT ?, ?, 'category.delete', 'category', id, ?, ?, ?, ?
        FROM categories WHERE id = ? AND admin_revision = ?
      `).bind(
        `audit:${crypto.randomUUID()}`, user.id, beforeJson, afterJson,
        requestIp(context.request), now, existing.id, revision,
      ),
      catalogRevisionBump(
        db,
        'EXISTS (SELECT 1 FROM categories WHERE id = ? AND admin_revision = ?)',
        [existing.id, revision],
      ),
    ]);
    if (changedRows(results?.[0]) === 0) {
      return apiError('CATEGORY_REVISION_CONFLICT', 'Category was changed by another administrator', 409);
    }
    return json({ ok: true, changed: true, category: await getAdminCategory(db, existing.id) }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return categoryError(error);
  }
}
