import { CustomerAuthError, resolveCustomer } from '../../../_lib/customer-auth.js';
import { customerOrderSummary } from '../../../_lib/customer-account.js';
import { customerApiError } from '../../../_lib/customer-http.js';
import { json } from '../../../_lib/http.js';
import { ORDER_TRANSITIONS } from '../../../_lib/order-lifecycle.js';

export async function onRequestGet(context) {
  try {
    const auth = await resolveCustomer(context, { required: true });
    const url = new URL(context.request.url);
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '30', 10) || 30));
    const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    const status = String(url.searchParams.get('status') || '').trim();
    if (status && !Object.hasOwn(ORDER_TRANSITIONS, status)) {
      throw new CustomerAuthError('INVALID_ORDER_STATUS', 'Unknown order status');
    }
    const statusClause = status ? 'AND o.status = ?' : '';
    const bindings = status ? [auth.user.id, status] : [auth.user.id];
    const [ordersResult, countRow] = await Promise.all([
      auth.db.prepare(`
        SELECT o.*,
               COALESCE(
                 (SELECT code_snapshot FROM promo_redemptions WHERE order_id = o.id),
                 (SELECT code FROM promo_codes WHERE id = o.promo_code_id)
               ) AS promo_code,
               COUNT(oi.id) AS line_count, COALESCE(SUM(oi.quantity), 0) AS item_count
        FROM orders o
        LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE o.user_id = ? ${statusClause}
        GROUP BY o.id
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ? OFFSET ?
      `).bind(...bindings, limit, offset).all(),
      auth.db.prepare(`
        SELECT COUNT(*) AS count FROM orders o
        WHERE o.user_id = ? ${statusClause}
      `).bind(...bindings).first(),
    ]);
    return json({
      ok: true,
      items: (ordersResult.results || []).map(customerOrderSummary),
      pagination: { limit, offset, total: Number(countRow?.count || 0) },
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return customerApiError(error);
  }
}
