import { ORDER_TRANSITIONS } from './order-lifecycle.js';

const number = (value) => Number(value || 0);

export const adminOrderSummary = (row) => ({
  id: row.id,
  no: row.order_no,
  status: row.status,
  language: row.language,
  customerName: row.customer_name,
  customerPhone: row.customer_phone,
  customerEmail: row.customer_email,
  deliveryMethod: row.delivery_method,
  deliveryLabel: row.delivery_label,
  paymentMethod: row.payment_method,
  paymentLabel: row.payment_label,
  itemCount: number(row.item_count),
  lineCount: number(row.line_count),
  promoDiscount: number(row.promo_discount),
  promoCode: row.promo_code || null,
  total: number(row.total_amount),
  createdAt: row.created_at,
  reservationExpiresAt: row.reservation_expires_at,
});

export function adminOrderForRole(order, role) {
  if (!order || role === 'admin') return order;
  const redacted = { ...order };
  delete redacted.promoCode;
  delete redacted.promoCodeId;
  return redacted;
}

export async function getAdminOrder(db, id) {
  const order = await db.prepare(`
    SELECT o.*, COALESCE(pr.code_snapshot, pc.code) AS promo_code
    FROM orders o
    LEFT JOIN promo_redemptions pr ON pr.order_id = o.id
    LEFT JOIN promo_codes pc ON pc.id = o.promo_code_id
    WHERE o.id = ? OR o.order_no = ? LIMIT 1
  `).bind(id, id).first();
  if (!order) return null;
  const [
    itemsResult,
    historyResult,
    movementResult,
    returnResult,
    returnItemResult,
    notificationResult,
  ] = await Promise.all([
    db.prepare(`
      SELECT id, product_id, product_key, sku, brand, name, unit_price, list_price,
             quantity, sold_quantity, returned_quantity, line_total
      FROM order_items WHERE order_id = ? ORDER BY id
    `).bind(order.id).all(),
    db.prepare(`
      SELECT h.id, h.from_status, h.to_status, h.comment, h.created_at,
             h.actor_user_id, u.name AS actor_name, u.email AS actor_email
      FROM order_status_history h
      LEFT JOIN users u ON u.id = h.actor_user_id
      WHERE h.order_id = ? ORDER BY h.id
    `).bind(order.id).all(),
    db.prepare(`
      SELECT m.id, m.movement_type, m.delta_on_hand, m.delta_reserved,
             m.balance_on_hand, m.balance_reserved, m.reason, m.created_at,
             p.catalog_key, p.sku, p.name_ro
      FROM inventory_movements m
      JOIN products p ON p.id = m.product_id
      WHERE m.order_id = ? ORDER BY m.created_at, m.id
    `).bind(order.id).all(),
    db.prepare(`
      SELECT r.id, r.request_key, r.return_kind, r.items_amount, r.promo_refund_amount,
             r.reason, r.created_at,
             r.actor_user_id, u.name AS actor_name, u.email AS actor_email
      FROM order_returns r
      LEFT JOIN users u ON u.id = r.actor_user_id
      WHERE r.order_id = ? ORDER BY r.created_at, r.id
    `).bind(order.id).all(),
    db.prepare(`
      SELECT ri.id, ri.return_id, ri.order_item_id, ri.product_id, ri.quantity,
             ri.unit_price, ri.line_amount, ri.promo_refund_amount,
             oi.product_key, oi.sku, oi.name
      FROM order_return_items ri
      JOIN order_returns r ON r.id = ri.return_id
      JOIN order_items oi ON oi.id = ri.order_item_id
      WHERE r.order_id = ? ORDER BY ri.id
    `).bind(order.id).all(),
    Promise.resolve().then(() => db.prepare(`
        SELECT a.id, a.channel, a.event_type, a.created_at, a.actor_user_id,
               u.name AS actor_name, u.email AS actor_email,
               outcome.status, outcome.failure_code, outcome.provider_status,
               outcome.created_at AS completed_at
        FROM notification_attempts a
        LEFT JOIN users u ON u.id = a.actor_user_id
        LEFT JOIN notification_attempt_statuses outcome
          ON outcome.attempt_id = a.id AND outcome.phase = 'outcome'
        WHERE a.order_id = ?
        ORDER BY a.created_at, a.id
      `).bind(order.id).all()).catch((error) => {
        // During a migration-first rolling release an older local/preview schema
        // can briefly serve the new admin bundle. Core order details remain
        // available, while production readiness still reports the missing gate.
        if (/no such table:\s*notification_/i.test(String(error?.message || error))) {
          return { results: [] };
        }
        throw error;
      }),
  ]);

  const returnItems = new Map();
  for (const item of returnItemResult.results || []) {
    const entries = returnItems.get(item.return_id) || [];
    entries.push({
      id: item.id,
      orderItemId: item.order_item_id,
      productId: item.product_id,
      productKey: item.product_key,
      sku: item.sku,
      name: item.name,
      quantity: number(item.quantity),
      unitPrice: number(item.unit_price),
      lineAmount: number(item.line_amount),
      promoRefundAmount: number(item.promo_refund_amount),
      refundAmount: number(item.line_amount) - number(item.promo_refund_amount),
    });
    returnItems.set(item.return_id, entries);
  }

  return {
    ...adminOrderSummary({
      ...order,
      item_count: (itemsResult.results || []).reduce((sum, item) => sum + number(item.quantity), 0),
      line_count: (itemsResult.results || []).length,
    }),
    customer: {
      name: order.customer_name,
      phone: order.customer_phone,
      email: order.customer_email,
      city: order.city,
      address: order.address,
      comment: order.customer_comment,
    },
    internalComment: order.internal_comment,
    internalCommentRevision: order.internal_comment_revision || null,
    itemsSubtotal: number(order.items_subtotal),
    catalogDiscount: number(order.catalog_discount),
    promoDiscount: number(order.promo_discount),
    deliveryFee: number(order.delivery_fee),
    promoCodeId: order.promo_code_id,
    promoCode: order.promo_code || null,
    confirmedAt: order.confirmed_at,
    completedAt: order.completed_at,
    cancelledAt: order.cancelled_at,
    updatedAt: order.updated_at,
    allowedTransitions: ORDER_TRANSITIONS[order.status] || [],
    items: (itemsResult.results || []).map((item) => ({
      id: item.id,
      productId: item.product_id,
      productKey: item.product_key,
      sku: item.sku,
      brand: item.brand,
      name: item.name,
      unitPrice: number(item.unit_price),
      listPrice: number(item.list_price),
      quantity: number(item.quantity),
      soldQuantity: number(item.sold_quantity),
      returnedQuantity: number(item.returned_quantity),
      returnableQuantity: Math.max(0, number(item.sold_quantity) - number(item.returned_quantity)),
      lineTotal: number(item.line_total),
    })),
    history: (historyResult.results || []).map((entry) => ({
      id: entry.id,
      fromStatus: entry.from_status,
      toStatus: entry.to_status,
      comment: entry.comment,
      createdAt: entry.created_at,
    })),
    movements: (movementResult.results || []).map((movement) => ({
      id: movement.id,
      type: movement.movement_type,
      deltaOnHand: number(movement.delta_on_hand),
      deltaReserved: number(movement.delta_reserved),
      balanceOnHand: number(movement.balance_on_hand),
      balanceReserved: number(movement.balance_reserved),
      reason: movement.reason,
      createdAt: movement.created_at,
      product: {
        key: movement.catalog_key,
        sku: movement.sku,
        name: movement.name_ro,
      },
    })),
    returns: (returnResult.results || []).map((entry) => ({
      id: entry.id,
      requestKey: entry.request_key,
      kind: entry.return_kind,
      itemsAmount: number(entry.items_amount),
      promoRefundAmount: number(entry.promo_refund_amount),
      refundAmount: number(entry.items_amount) - number(entry.promo_refund_amount),
      reason: entry.reason,
      createdAt: entry.created_at,
      actor: entry.actor_user_id ? {
        id: entry.actor_user_id,
        name: entry.actor_name,
        email: entry.actor_email,
      } : null,
      items: returnItems.get(entry.id) || [],
    })),
    notifications: (notificationResult.results || []).map((entry) => ({
      id: entry.id,
      channel: entry.channel,
      eventType: entry.event_type,
      status: entry.status || 'pending',
      failureCode: entry.failure_code || '',
      providerStatus: entry.provider_status === null || entry.provider_status === undefined
        ? null
        : number(entry.provider_status),
      createdAt: entry.created_at,
      completedAt: entry.completed_at || null,
      actor: entry.actor_user_id ? {
        id: entry.actor_user_id,
        name: entry.actor_name,
        email: entry.actor_email,
      } : null,
    })),
  };
}
