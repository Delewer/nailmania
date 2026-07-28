import { requireAdmin } from '../../../_lib/admin-auth.js';
import { apiError, handleApiError, json } from '../../../_lib/http.js';
import { clampLikeTerm, likeContainsPattern } from '../../../_lib/search-pattern.js';

const pageInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const dateBound = (value, end = false) => {
  const input = String(value || '').trim();
  if (!input) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const date = new Date(`${input}T00:00:00.000Z`);
    if (Number.isNaN(date.valueOf())) return null;
    if (end) date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString();
  }
  const date = new Date(input);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
};

const parseJson = (value) => {
  if (value === null || value === undefined || value === '') return null;
  try { return JSON.parse(value); }
  catch { return null; }
};

export async function onRequestGet(context) {
  try {
    const { db } = await requireAdmin(context, ['admin']);
    const url = new URL(context.request.url);
    const limit = pageInteger(url.searchParams.get('limit'), 50, 1, 100);
    const offset = pageInteger(url.searchParams.get('offset'), 0, 0, 1_000_000_000);
    const action = String(url.searchParams.get('action') || '').trim().slice(0, 120);
    const entityType = String(url.searchParams.get('entityType') || '').trim().slice(0, 80);
    const actor = String(url.searchParams.get('actor') || '').trim().slice(0, 120);
    const search = clampLikeTerm(url.searchParams.get('q'));
    const from = dateBound(url.searchParams.get('from'));
    const to = dateBound(url.searchParams.get('to'), true);
    if (from === null || to === null) return apiError('INVALID_DATE_FILTER', 'Audit log date filter is invalid', 400);

    const conditions = [];
    const bindings = [];
    if (action) { conditions.push('a.action = ?'); bindings.push(action); }
    if (entityType) { conditions.push('a.entity_type = ?'); bindings.push(entityType); }
    if (actor) {
      conditions.push('(a.actor_user_id = ? OR u.email = ? COLLATE NOCASE)');
      bindings.push(actor, actor);
    }
    if (from) { conditions.push('a.created_at >= ?'); bindings.push(from); }
    if (to) { conditions.push('a.created_at < ?'); bindings.push(to); }
    if (search) {
      const pattern = likeContainsPattern(search);
      conditions.push(`(
        a.action LIKE ? OR a.entity_type LIKE ? OR a.entity_id LIKE ?
        OR u.name LIKE ? OR u.email LIKE ?
      )`);
      bindings.push(pattern, pattern, pattern, pattern, pattern);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const joins = `
      FROM admin_audit_log a
      LEFT JOIN users u ON u.id = a.actor_user_id
    `;
    const [result, count] = await Promise.all([
      db.prepare(`
        SELECT a.id, a.action, a.entity_type, a.entity_id,
               a.before_json, a.after_json, a.request_ip, a.created_at,
               u.id AS actor_id, u.name AS actor_name, u.email AS actor_email
        ${joins} ${where}
        ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?
      `).bind(...bindings, limit, offset).all(),
      db.prepare(`SELECT COUNT(*) AS count ${joins} ${where}`).bind(...bindings).first(),
    ]);
    return json({
      ok: true,
      items: (result.results || []).map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        before: parseJson(row.before_json),
        after: parseJson(row.after_json),
        requestIp: row.request_ip,
        createdAt: row.created_at,
        actor: row.actor_id ? { id: row.actor_id, name: row.actor_name, email: row.actor_email } : null,
      })),
      pagination: { limit, offset, total: Number(count?.count || 0) },
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return handleApiError(error);
  }
}
