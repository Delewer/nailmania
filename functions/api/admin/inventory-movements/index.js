import { requireAdmin } from '../../../_lib/admin-auth.js';
import { apiError, handleApiError, json } from '../../../_lib/http.js';
import { clampLikeTerm, likeContainsPattern } from '../../../_lib/search-pattern.js';

const MOVEMENT_TYPES = new Set([
  'opening_balance', 'receipt', 'reservation', 'reservation_release',
  'sale', 'return', 'write_off', 'adjustment',
]);

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

export async function onRequestGet(context) {
  try {
    const { db } = await requireAdmin(context, ['manager', 'admin']);
    const url = new URL(context.request.url);
    const limit = pageInteger(url.searchParams.get('limit'), 50, 1, 100);
    const offset = pageInteger(url.searchParams.get('offset'), 0, 0, 1_000_000_000);
    const type = String(url.searchParams.get('type') || '').trim();
    const search = clampLikeTerm(url.searchParams.get('q'));
    const order = String(url.searchParams.get('order') || '').trim().slice(0, 120);
    const product = String(url.searchParams.get('product') || '').trim().slice(0, 120);
    const from = dateBound(url.searchParams.get('from'));
    const to = dateBound(url.searchParams.get('to'), true);
    if (type && !MOVEMENT_TYPES.has(type)) return apiError('INVALID_MOVEMENT_TYPE', 'Unknown inventory movement type', 400);
    if (from === null || to === null) return apiError('INVALID_DATE_FILTER', 'Inventory journal date filter is invalid', 400);

    const conditions = [];
    const bindings = [];
    if (type) { conditions.push('m.movement_type = ?'); bindings.push(type); }
    if (order) {
      conditions.push('(m.order_id = ? OR o.order_no = ?)');
      bindings.push(order, order);
    }
    if (product) {
      conditions.push('(CAST(m.product_id AS TEXT) = ? OR p.catalog_key = ? OR p.sku = ?)');
      bindings.push(product, product, product);
    }
    if (from) { conditions.push('m.created_at >= ?'); bindings.push(from); }
    if (to) { conditions.push('m.created_at < ?'); bindings.push(to); }
    if (search) {
      const pattern = likeContainsPattern(search);
      conditions.push(`(
        p.catalog_key LIKE ? OR p.sku LIKE ? OR p.name_ro LIKE ? OR p.name_ru LIKE ?
        OR o.order_no LIKE ? OR m.reason LIKE ? OR u.name LIKE ? OR u.email LIKE ?
      )`);
      bindings.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const joins = `
      FROM inventory_movements m
      JOIN products p ON p.id = m.product_id
      JOIN warehouses w ON w.id = m.warehouse_id
      LEFT JOIN orders o ON o.id = m.order_id
      LEFT JOIN users u ON u.id = m.actor_user_id
    `;
    const [result, count] = await Promise.all([
      db.prepare(`
        SELECT m.id, m.product_id, m.warehouse_id, m.movement_type,
               m.delta_on_hand, m.delta_reserved, m.balance_on_hand, m.balance_reserved,
               m.order_id, m.reason, m.created_at,
               p.catalog_key, p.sku, p.name_ro, p.name_ru,
               w.name AS warehouse_name, o.order_no,
               u.id AS actor_id, u.name AS actor_name, u.email AS actor_email
        ${joins} ${where}
        ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?
      `).bind(...bindings, limit, offset).all(),
      db.prepare(`SELECT COUNT(*) AS count ${joins} ${where}`).bind(...bindings).first(),
    ]);
    return json({
      ok: true,
      items: (result.results || []).map((row) => ({
        id: row.id,
        type: row.movement_type,
        deltaOnHand: Number(row.delta_on_hand || 0),
        deltaReserved: Number(row.delta_reserved || 0),
        balanceOnHand: Number(row.balance_on_hand || 0),
        balanceReserved: Number(row.balance_reserved || 0),
        reason: row.reason,
        createdAt: row.created_at,
        warehouse: { id: row.warehouse_id, name: row.warehouse_name },
        product: {
          id: row.product_id,
          key: row.catalog_key,
          sku: row.sku,
          name: row.name_ro,
          nameRu: row.name_ru,
        },
        order: row.order_id ? { id: row.order_id, no: row.order_no } : null,
        actor: row.actor_id ? { id: row.actor_id, name: row.actor_name, email: row.actor_email } : null,
      })),
      pagination: { limit, offset, total: Number(count?.count || 0) },
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return handleApiError(error);
  }
}
