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
    const conditions = [
      `o.status NOT IN ('completed', 'cancelled', 'returned')`,
      'oi.quantity > oi.sold_quantity',
    ];
    const bindings = [];
    // Kept as an empty compatibility filter for an admin tab opened before the
    // cart-reservation removal. There are no active cart holds anymore.
    if (state === 'active') conditions.push('1 = 0');
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
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
    `;
    const openWhere = `WHERE o.status NOT IN ('completed', 'cancelled', 'returned')
      AND oi.quantity > oi.sold_quantity`;
    const now = new Date().toISOString();

    const [rows, count, summary] = await Promise.all([
      db.prepare(`
        SELECT oi.id, oi.quantity - oi.sold_quantity AS reserved_quantity,
               p.id AS product_id, p.catalog_key, p.sku, p.name_ro, p.name_ru,
               i.on_hand, i.reserved,
               o.id AS order_id, o.order_no, o.status AS order_status,
               o.customer_name, o.delivery_label, o.created_at AS order_created_at,
               o.updated_at AS order_updated_at
        ${joins} ${where}
        ORDER BY o.created_at DESC, oi.id DESC
        LIMIT ? OFFSET ?
      `).bind(...bindings, limit, offset).all(),
      db.prepare(`SELECT COUNT(*) AS count ${joins} ${where}`).bind(...bindings).first(),
      db.prepare(`
        SELECT COUNT(DISTINCT o.id) AS orders,
               COALESCE(SUM(oi.quantity - oi.sold_quantity), 0) AS units
        ${joins} ${openWhere}
      `).first(),
    ]);

    const openOrders = Number(summary?.orders || 0);
    const reservedUnits = Number(summary?.units || 0);
    return json({
      ok: true,
      serverNow: now,
      summary: {
        openOrders,
        reservedUnits,
        activeReservations: 0,
        activeUnits: 0,
        recentOrders: openOrders,
        recentOrderedUnits: reservedUnits,
      },
      items: (rows.results || []).map((row) => {
        const reserved = Number(row.reserved || 0);
        const onHand = Number(row.on_hand || 0);
        return {
          id: `order:${row.order_id}:${row.id}`,
          quantity: Number(row.reserved_quantity),
          state: 'ordered',
          expiresAt: null,
          createdAt: row.order_created_at,
          updatedAt: row.order_updated_at,
          product: {
            id: Number(row.product_id), key: row.catalog_key, sku: row.sku,
            name: row.name_ro, nameRu: row.name_ru,
          },
          inventory: { onHand, reserved, available: Math.max(0, onHand - reserved) },
          order: {
            id: row.order_id, no: row.order_no, status: row.order_status,
            customerName: row.customer_name, deliveryLabel: row.delivery_label,
            createdAt: row.order_created_at, updatedAt: row.order_updated_at,
          },
        };
      }),
      pagination: { limit, offset, total: Number(count?.count || 0) },
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return handleApiError(error);
  }
}
