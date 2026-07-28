import { requireAdmin } from '../../../_lib/admin-auth.js';
import { adminOrderForRole, adminOrderSummary } from '../../../_lib/admin-orders.js';
import { handleApiError, json } from '../../../_lib/http.js';
import { ORDER_TRANSITIONS } from '../../../_lib/order-lifecycle.js';
import { clampLikeTerm, likeContainsPattern } from '../../../_lib/search-pattern.js';

export async function onRequestGet(context) {
  try {
    const { db, user } = await requireAdmin(context);
    const url = new URL(context.request.url);
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '30', 10)));
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10));
    const status = String(url.searchParams.get('status') || '').trim();
    const search = clampLikeTerm(url.searchParams.get('q'));
    if (status && !Object.hasOwn(ORDER_TRANSITIONS, status)) {
      return json({ ok: false, error: { code: 'INVALID_STATUS', message: 'Unknown order status' } }, 400);
    }

    const conditions = [];
    const bindings = [];
    if (status) { conditions.push('o.status = ?'); bindings.push(status); }
    if (search) {
      conditions.push(`(
        o.order_no LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ? OR o.customer_email LIKE ?
      )`);
      const pattern = likeContainsPattern(search);
      bindings.push(pattern, pattern, pattern, pattern);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [ordersResult, countRow, statusResult] = await Promise.all([
      db.prepare(`
        SELECT o.*, COALESCE(pr.code_snapshot, pc.code) AS promo_code,
               COUNT(oi.id) AS line_count, COALESCE(SUM(oi.quantity), 0) AS item_count
        FROM orders o
        LEFT JOIN promo_redemptions pr ON pr.order_id = o.id
        LEFT JOIN promo_codes pc ON pc.id = o.promo_code_id
        LEFT JOIN order_items oi ON oi.order_id = o.id
        ${where}
        GROUP BY o.id
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ? OFFSET ?
      `).bind(...bindings, limit, offset).all(),
      db.prepare(`SELECT COUNT(*) AS count FROM orders o ${where}`).bind(...bindings).first(),
      db.prepare('SELECT status, COUNT(*) AS count FROM orders GROUP BY status').all(),
    ]);
    const counts = Object.fromEntries(Object.keys(ORDER_TRANSITIONS).map((key) => [key, 0]));
    for (const row of statusResult.results || []) counts[row.status] = Number(row.count || 0);

    return json({
      ok: true,
      items: (ordersResult.results || []).map((row) => adminOrderForRole(adminOrderSummary(row), user.role)),
      counts,
      pagination: { limit, offset, total: Number(countRow?.count || 0) },
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return handleApiError(error);
  }
}
