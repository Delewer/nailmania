import { requireAdmin } from '../../../_lib/admin-auth.js';
import { apiError, handleApiError, json } from '../../../_lib/http.js';
import { clampLikeTerm, likeContainsPattern } from '../../../_lib/search-pattern.js';

const STATES = new Set(['all', 'active', 'ordered']);

const pageInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

export async function onRequestGet(context) {
  try {
    const { db } = await requireAdmin(context, ['manager', 'admin']);
    const url = new URL(context.request.url);
    const state = String(url.searchParams.get('state') || 'all').trim();
    if (!STATES.has(state)) return apiError('INVALID_RESERVATION_STATE', 'Unknown reservation state', 400);
    const limit = pageInteger(url.searchParams.get('limit'), 50, 1, 100);
    const offset = pageInteger(url.searchParams.get('offset'), 0, 0, 1_000_000_000);
    const search = clampLikeTerm(url.searchParams.get('q'));
    const now = new Date().toISOString();
    const recentSince = new Date(Date.parse(now) - 7 * 24 * 60 * 60 * 1000).toISOString();

    const activeCondition = `(r.status = 'ACTIVE' AND r.expires_at > ?)`;
    const orderedCondition = `(r.status = 'CONVERTED' AND o.created_at >= ?
      AND o.status NOT IN ('completed', 'cancelled', 'returned'))`;
    const conditions = [];
    const bindings = [];
    if (state === 'active') {
      conditions.push(activeCondition);
      bindings.push(now);
    } else if (state === 'ordered') {
      conditions.push(orderedCondition);
      bindings.push(recentSince);
    } else {
      conditions.push(`(${activeCondition} OR ${orderedCondition})`);
      bindings.push(now, recentSince);
    }
    if (search) {
      const pattern = likeContainsPattern(search);
      conditions.push(`(
        p.catalog_key LIKE ? OR p.sku LIKE ? OR p.name_ro LIKE ? OR p.name_ru LIKE ?
        OR o.order_no LIKE ? OR o.customer_name LIKE ?
      )`);
      bindings.push(pattern, pattern, pattern, pattern, pattern, pattern);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const joins = `
      FROM cart_reservations r
      JOIN products p ON p.id = r.product_id
      JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
      LEFT JOIN orders o ON o.id = r.order_id
    `;
    const effectiveReserved = `MAX(0, i.reserved - COALESCE((
      SELECT SUM(expired.quantity)
      FROM cart_reservations expired
      WHERE expired.product_id = p.id AND expired.status = 'ACTIVE' AND expired.expires_at <= ?
    ), 0))`;

    const [rows, count, activeSummary, orderSummary] = await Promise.all([
      db.prepare(`
        SELECT r.id, r.quantity, r.status, r.expires_at,
               r.created_at, r.updated_at,
               p.id AS product_id, p.catalog_key, p.sku, p.name_ro, p.name_ru,
               i.on_hand, ${effectiveReserved} AS effective_reserved,
               o.id AS order_id, o.order_no, o.status AS order_status,
               o.customer_name, o.delivery_label, o.created_at AS order_created_at,
               o.updated_at AS order_updated_at
        ${joins} ${where}
        ORDER BY CASE r.status WHEN 'ACTIVE' THEN 0 ELSE 1 END,
                 CASE WHEN r.status = 'ACTIVE' THEN r.expires_at ELSE o.created_at END DESC,
                 r.id DESC
        LIMIT ? OFFSET ?
      `).bind(now, ...bindings, limit, offset).all(),
      db.prepare(`SELECT COUNT(*) AS count ${joins} ${where}`).bind(...bindings).first(),
      db.prepare(`
        SELECT COUNT(*) AS reservations, COALESCE(SUM(quantity), 0) AS units
        FROM cart_reservations
        WHERE status = 'ACTIVE' AND expires_at > ?
      `).bind(now).first(),
      db.prepare(`
        SELECT COUNT(DISTINCT r.order_id) AS orders, COALESCE(SUM(r.quantity), 0) AS units
        FROM cart_reservations r
        JOIN orders o ON o.id = r.order_id
        WHERE r.status = 'CONVERTED' AND o.created_at >= ?
          AND o.status NOT IN ('completed', 'cancelled', 'returned')
      `).bind(recentSince).first(),
    ]);

    return json({
      ok: true,
      serverNow: now,
      recentDays: 7,
      summary: {
        activeReservations: Number(activeSummary?.reservations || 0),
        activeUnits: Number(activeSummary?.units || 0),
        recentOrders: Number(orderSummary?.orders || 0),
        recentOrderedUnits: Number(orderSummary?.units || 0),
      },
      items: (rows.results || []).map((row) => {
        const reserved = Number(row.effective_reserved || 0);
        const onHand = Number(row.on_hand || 0);
        return {
          id: row.id,
          quantity: Number(row.quantity),
          state: row.status === 'ACTIVE' ? 'active' : 'ordered',
          expiresAt: row.status === 'ACTIVE' ? row.expires_at : null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          product: {
            id: Number(row.product_id), key: row.catalog_key, sku: row.sku,
            name: row.name_ro, nameRu: row.name_ru,
          },
          inventory: { onHand, reserved, available: Math.max(0, onHand - reserved) },
          order: row.order_id ? {
            id: row.order_id, no: row.order_no, status: row.order_status,
            customerName: row.customer_name, deliveryLabel: row.delivery_label,
            createdAt: row.order_created_at, updatedAt: row.order_updated_at,
          } : null,
        };
      }),
      pagination: { limit, offset, total: Number(count?.count || 0) },
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return handleApiError(error);
  }
}
