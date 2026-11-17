import { requireAdmin } from '../../../_lib/admin-auth.js';
import { adminOrderForRole, adminOrderSummary } from '../../../_lib/admin-orders.js';
import { handleApiError, json } from '../../../_lib/http.js';
import {
  normalizePublicOrderStatus,
  ORDER_STATUSES,
} from '../../../_lib/order-lifecycle.js';
import { clampLikeTerm, likeContainsPattern } from '../../../_lib/search-pattern.js';

export async function onRequestGet(context) {
  try {
    const { db, user } = await requireAdmin(context);
    const url = new URL(context.request.url);
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '30', 10)));
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10));
    const requestedStatus = String(url.searchParams.get('status') || '').trim();
    const status = normalizePublicOrderStatus(requestedStatus);
    const search = clampLikeTerm(url.searchParams.get('q'));
    if (status && !ORDER_STATUSES.includes(status)) {
      return json({ ok: false, error: { code: 'INVALID_STATUS', message: 'Unknown order status' } }, 400);
    }

    const conditions = [];
    const bindings = [];
    if (status === 'completed') {
      conditions.push("o.status IN ('completed', 'confirmed', 'processing', 'ready', 'shipped')");
    } else if (status) {
      conditions.push('o.status = ?');
      bindings.push(status);
    }
    if (search) {
      conditions.push(`(
        o.order_no LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ? OR o.customer_email LIKE ?
      )`);
      const pattern = likeContainsPattern(search);
      bindings.push(pattern, pattern, pattern, pattern);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [ordersResult, countRow, statusResult, latestPendingRow] = await Promise.all([
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
      db.prepare(`
        SELECT id, order_no, created_at FROM orders
        WHERE status = 'pending'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).first(),
    ]);
    const counts = Object.fromEntries(ORDER_STATUSES.map((key) => [key, 0]));
    for (const row of statusResult.results || []) {
      const key = normalizePublicOrderStatus(row.status);
      if (Object.hasOwn(counts, key)) counts[key] += Number(row.count || 0);
    }

    return json({
      ok: true,
      items: (ordersResult.results || []).map((row) => adminOrderForRole(adminOrderSummary(row), user.role)),
      counts,
      latestPending: latestPendingRow ? {
        id: latestPendingRow.id,
        no: latestPendingRow.order_no,
        createdAt: latestPendingRow.created_at,
      } : null,
      pagination: { limit, offset, total: Number(countRow?.count || 0) },
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return handleApiError(error);
  }
}
