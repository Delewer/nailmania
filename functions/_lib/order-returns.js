import { catalogRevisionBump } from './catalog-cache.js';
import { cumulativePromoRefund } from './promos.js';

export class OrderReturnError extends Error {
  constructor(code, message, status = 409, details) {
    super(message);
    this.name = 'OrderReturnError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const number = (value) => Number(value || 0);
const changedRows = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);
const MAX_RETURN_LINES = 100;
// The largest statement below uses three values per line plus eight fixed
// bindings: 30 * 3 + 8 = 98, below D1's 100-parameter ceiling.
const RETURN_LINES_PER_STATEMENT = 30;

const chunks = (items, size) => {
  const result = [];
  for (let offset = 0; offset < items.length; offset += size) {
    result.push(items.slice(offset, offset + size));
  }
  return result;
};

const integer = (value, field, options = {}) => {
  const parsed = Number(value);
  const min = options.min ?? 1;
  const max = options.max ?? 1_000_000;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new OrderReturnError(
      'INVALID_RETURN_ITEM',
      `${field} must be an integer from ${min} to ${max}`,
      400,
      { field },
    );
  }
  return parsed;
};

const fingerprint = async (value) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const normalizeItems = (value) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RETURN_LINES) {
    throw new OrderReturnError(
      'INVALID_RETURN_ITEMS',
      `Return items must be a non-empty array of at most ${MAX_RETURN_LINES} lines`,
      400,
    );
  }
  const seen = new Set();
  return value.map((entry, index) => {
    const orderItemId = integer(entry?.orderItemId, `items[${index}].orderItemId`);
    const quantity = integer(entry?.quantity, `items[${index}].quantity`);
    if (seen.has(orderItemId)) {
      throw new OrderReturnError('DUPLICATE_RETURN_ITEM', 'Each order item may appear only once in a return', 400, { orderItemId });
    }
    seen.add(orderItemId);
    return { orderItemId, quantity };
  }).sort((left, right) => left.orderItemId - right.orderItemId);
};

export async function getOrderReturn(db, returnId) {
  const row = await db.prepare(`
    SELECT r.*, o.order_no, u.name AS actor_name, u.email AS actor_email
    FROM order_returns r
    JOIN orders o ON o.id = r.order_id
    LEFT JOIN users u ON u.id = r.actor_user_id
    WHERE r.id = ?
  `).bind(returnId).first();
  if (!row) return null;
  const result = await db.prepare(`
    SELECT ri.id, ri.order_item_id, ri.product_id, ri.quantity,
           ri.unit_price, ri.line_amount, ri.promo_refund_amount,
           oi.product_key, oi.sku, oi.name
    FROM order_return_items ri
    JOIN order_items oi ON oi.id = ri.order_item_id
    WHERE ri.return_id = ? ORDER BY ri.id
  `).bind(row.id).all();
  return {
    id: row.id,
    orderId: row.order_id,
    orderNo: row.order_no,
    requestKey: row.request_key,
    kind: row.return_kind,
    itemsAmount: number(row.items_amount),
    promoRefundAmount: number(row.promo_refund_amount),
    refundAmount: number(row.items_amount) - number(row.promo_refund_amount),
    reason: row.reason,
    createdAt: row.created_at,
    actor: row.actor_user_id ? {
      id: row.actor_user_id,
      name: row.actor_name,
      email: row.actor_email,
    } : null,
    items: (result.results || []).map((item) => ({
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
    })),
  };
}

async function idempotentResult(db, orderId, requestKey, requestFingerprint) {
  const existing = await db.prepare(`
    SELECT id, request_fingerprint FROM order_returns
    WHERE order_id = ? AND request_key = ?
  `).bind(orderId, requestKey).first();
  if (!existing) return null;
  if (existing.request_fingerprint !== requestFingerprint) {
    throw new OrderReturnError(
      'IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used for a different return request',
      409,
      { requestKey },
    );
  }
  return getOrderReturn(db, existing.id);
}

export async function createOrderReturn(db, options) {
  const database = typeof db.withSession === 'function' ? db.withSession('first-primary') : db;
  const requestedOrderId = text(options?.orderId, 120);
  const requestKey = text(options?.requestKey, 120);
  const actorUserId = text(options?.actorUserId, 120) || null;
  const reason = text(options?.reason, 1000);
  const requestIp = text(options?.requestIp, 80);
  const now = options?.now ? new Date(options.now).toISOString() : new Date().toISOString();
  if (!requestedOrderId) throw new OrderReturnError('INVALID_ORDER_ID', 'Order id is required', 400);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/.test(requestKey)) {
    throw new OrderReturnError('IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required', 400);
  }
  if (reason.length < 3) throw new OrderReturnError('RETURN_REASON_REQUIRED', 'Return reason must contain at least 3 characters', 400);
  const requestedItems = normalizeItems(options?.items);

  const order = await database.prepare(`
    SELECT id, order_no, status, COALESCE(return_revision, '') AS return_revision
    FROM orders WHERE id = ? OR order_no = ? LIMIT 1
  `).bind(requestedOrderId, requestedOrderId).first();
  if (!order) throw new OrderReturnError('ORDER_NOT_FOUND', 'Order not found', 404, { orderId: requestedOrderId });

  const requestFingerprint = await fingerprint({
    orderId: order.id,
    reason,
    items: requestedItems,
  });
  const previous = await idempotentResult(database, order.id, requestKey, requestFingerprint);
  if (previous) return { created: false, return: previous };
  if (order.status !== 'completed') {
    throw new OrderReturnError(
      'ORDER_RETURN_NOT_ALLOWED',
      'Only a completed order can be returned',
      409,
      { orderId: order.id, status: order.status },
    );
  }

  const itemIds = requestedItems.map((item) => item.orderItemId);
  const placeholders = itemIds.map(() => '?').join(', ');
  const itemResult = await database.prepare(`
    SELECT oi.id, oi.order_id, oi.product_id, oi.product_key, oi.sku, oi.name,
           oi.unit_price, oi.quantity, oi.sold_quantity, oi.returned_quantity,
           oi.promo_discount_allocation,
           i.warehouse_id, i.on_hand, i.reserved
    FROM order_items oi
    LEFT JOIN inventory i ON i.product_id = oi.product_id AND i.warehouse_id = 1
    WHERE oi.id IN (${placeholders})
  `).bind(...itemIds).all();
  const rows = itemResult.results || [];
  const byId = new Map(rows.map((row) => [number(row.id), row]));
  const lines = requestedItems.map((requested) => {
    const row = byId.get(requested.orderItemId);
    if (!row || row.order_id !== order.id) {
      throw new OrderReturnError(
        'RETURN_ITEM_NOT_OWNED',
        'Every returned item must belong to this order',
        400,
        { orderItemId: requested.orderItemId },
      );
    }
    if (number(row.warehouse_id) !== 1) {
      throw new OrderReturnError('INVENTORY_NOT_FOUND', 'Inventory is missing for a returned product', 409, { productId: row.product_id });
    }
    const returnable = number(row.sold_quantity) - number(row.returned_quantity);
    if (requested.quantity > returnable) {
      throw new OrderReturnError(
        'RETURN_QUANTITY_EXCEEDED',
        'Return quantity exceeds the sold quantity that has not already been returned',
        409,
        { orderItemId: requested.orderItemId, requested: requested.quantity, returnable },
      );
    }
    const previousPromoRefund = cumulativePromoRefund(
      number(row.promo_discount_allocation),
      number(row.quantity),
      number(row.returned_quantity),
    );
    const cumulativeAfter = cumulativePromoRefund(
      number(row.promo_discount_allocation),
      number(row.quantity),
      number(row.returned_quantity) + requested.quantity,
    );
    return {
      ...row,
      ...requested,
      returnable,
      promoRefundAmount: cumulativeAfter - previousPromoRefund,
    };
  });

  const allItemsResult = await database.prepare(`
    SELECT id, sold_quantity, returned_quantity FROM order_items WHERE order_id = ?
  `).bind(order.id).all();
  const requestedById = new Map(lines.map((line) => [number(line.id), line.quantity]));
  const remainingAfter = (allItemsResult.results || []).reduce((sum, item) => (
    sum + number(item.sold_quantity) - number(item.returned_quantity) - (requestedById.get(number(item.id)) || 0)
  ), 0);
  const returnKind = remainingAfter === 0 ? 'full' : 'partial';
  const itemsAmount = lines.reduce((sum, line) => sum + line.quantity * number(line.unit_price), 0);
  const promoRefundAmount = lines.reduce((sum, line) => sum + line.promoRefundAmount, 0);
  const returnId = `return:${crypto.randomUUID()}`;
  const revision = crypto.randomUUID();
  const statusToken = `return-status:${returnId}`;
  const beforeJson = JSON.stringify({
    status: order.status,
    items: lines.map((line) => ({ orderItemId: number(line.id), returnedQuantity: number(line.returned_quantity) })),
  });
  const afterJson = JSON.stringify({
    returnId,
    kind: returnKind,
    itemsAmount,
    promoRefundAmount,
    refundAmount: itemsAmount - promoRefundAmount,
  });
  const statements = [
    database.prepare(`
      UPDATE orders
      SET return_revision = ?,
          status = CASE WHEN ? = 'full' THEN 'returned' ELSE status END,
          transition_token = CASE WHEN ? = 'full' THEN ? ELSE transition_token END,
          reservation_expires_at = NULL,
          updated_at = ?
      WHERE id = ? AND status = 'completed' AND COALESCE(return_revision, '') = ?
    `).bind(revision, returnKind, returnKind, statusToken, now, order.id, order.return_revision),
    database.prepare(`
      INSERT INTO order_returns (
        id, order_id, request_key, request_fingerprint, return_kind,
        items_amount, promo_refund_amount, reason, actor_user_id, created_at
      )
      SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ? FROM orders
      WHERE id = ? AND return_revision = ?
    `).bind(
      returnId, requestKey, requestFingerprint, returnKind, itemsAmount, promoRefundAmount,
      reason, actorUserId, now, order.id, revision,
    ),
  ];

  for (const lineChunk of chunks(lines, RETURN_LINES_PER_STATEMENT)) {
    const values = lineChunk.map(() => '(?, ?, ?)').join(', ');
    const lineBindings = lineChunk.flatMap((line) => [line.id, line.quantity, line.promoRefundAmount]);
    const requested = `WITH requested(order_item_id, quantity, promo_refund_amount) AS (VALUES ${values})`;
    statements.push(
      database.prepare(`${requested}
        INSERT INTO order_return_items (
          return_id, order_item_id, product_id, quantity, unit_price, line_amount,
          promo_refund_amount
        )
        SELECT ?, oi.id, oi.product_id, r.quantity, oi.unit_price,
               r.quantity * oi.unit_price, r.promo_refund_amount
        FROM requested r
        JOIN order_items oi ON oi.id = r.order_item_id
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.order_id = ? AND o.return_revision = ?
          AND oi.returned_quantity + r.quantity <= oi.sold_quantity
      `).bind(...lineBindings, returnId, order.id, revision),
      database.prepare(`${requested}
        UPDATE inventory AS i
        SET on_hand = on_hand + (
              SELECT SUM(r.quantity)
              FROM requested r JOIN order_items oi ON oi.id = r.order_item_id
              WHERE oi.product_id = i.product_id
            ),
            updated_at = ?,
            admin_revision = 'order-return:' || ? || ':' || i.product_id
        WHERE i.warehouse_id = 1
          AND EXISTS (
            SELECT 1
            FROM requested r
            JOIN order_items oi ON oi.id = r.order_item_id
            JOIN orders o ON o.id = oi.order_id
            WHERE oi.product_id = i.product_id AND oi.order_id = ?
              AND o.return_revision = ?
              AND oi.returned_quantity + r.quantity <= oi.sold_quantity
          )
      `).bind(...lineBindings, now, returnId, order.id, revision),
      database.prepare(`${requested}
        INSERT INTO inventory_movements (
          id, product_id, warehouse_id, movement_type, delta_on_hand, delta_reserved,
          balance_on_hand, balance_reserved, order_id, actor_user_id, reason, created_at
        )
        SELECT 'return:' || ? || ':' || oi.product_id,
               oi.product_id, i.warehouse_id, 'return', SUM(r.quantity), 0,
               i.on_hand, i.reserved, ?, ?, ?, ?
        FROM requested r
        JOIN order_items oi ON oi.id = r.order_item_id
        JOIN orders o ON o.id = oi.order_id
        JOIN inventory i ON i.product_id = oi.product_id AND i.warehouse_id = 1
        WHERE oi.order_id = ? AND o.return_revision = ?
          AND i.admin_revision = 'order-return:' || ? || ':' || oi.product_id
          AND oi.returned_quantity + r.quantity <= oi.sold_quantity
        GROUP BY oi.product_id, i.warehouse_id, i.on_hand, i.reserved
      `).bind(
        ...lineBindings, returnId, order.id, actorUserId, reason, now,
        order.id, revision, returnId,
      ),
      database.prepare(`${requested}
        UPDATE order_items AS oi
        SET returned_quantity = returned_quantity + (
          SELECT r.quantity FROM requested r WHERE r.order_item_id = oi.id
        )
        WHERE oi.order_id = ?
          AND EXISTS (
            SELECT 1 FROM requested r JOIN orders o ON o.id = oi.order_id
            WHERE r.order_item_id = oi.id AND o.return_revision = ?
              AND oi.returned_quantity + r.quantity <= oi.sold_quantity
          )
      `).bind(...lineBindings, order.id, revision),
    );
  }

  if (returnKind === 'full') {
    statements.push(database.prepare(`
      INSERT INTO order_status_history (
        order_id, from_status, to_status, actor_user_id, comment, created_at, transition_token
      )
      SELECT id, 'completed', 'returned', ?, ?, ?, ? FROM orders
      WHERE id = ? AND status = 'returned' AND return_revision = ?
    `).bind(actorUserId, reason, now, statusToken, order.id, revision));
  }
  statements.push(database.prepare(`
    INSERT INTO admin_audit_log (
      id, actor_user_id, action, entity_type, entity_id,
      before_json, after_json, request_ip, created_at
    )
    SELECT ?, ?, 'order.return.create', 'order', id, ?, ?, ?, ? FROM orders
    WHERE id = ? AND return_revision = ?
  `).bind(
    `audit:${crypto.randomUUID()}`, actorUserId, beforeJson, afterJson,
    requestIp, now, order.id, revision,
  ));
  statements.push(catalogRevisionBump(database, `
    EXISTS (SELECT 1 FROM orders WHERE id = ? AND return_revision = ?)
  `, [order.id, revision]));

  let results;
  try {
    results = await database.batch(statements);
  } catch (error) {
    const existing = await idempotentResult(database, order.id, requestKey, requestFingerprint);
    if (existing) return { created: false, return: existing };
    if (/constraint failed|invalid order item sold\/returned quantities/i.test(String(error?.message || error))) {
      throw new OrderReturnError('RETURN_STATE_CONFLICT', 'Order return state changed while the return was being processed', 409);
    }
    throw error;
  }

  if (changedRows(results?.[0]) === 0) {
    const existing = await idempotentResult(database, order.id, requestKey, requestFingerprint);
    if (existing) return { created: false, return: existing };
    const current = await database.prepare('SELECT status, return_revision FROM orders WHERE id = ?').bind(order.id).first();
    throw new OrderReturnError(
      'ORDER_RETURN_CONFLICT',
      'Order return state changed concurrently; reload the order before retrying',
      409,
      { orderId: order.id, status: current?.status },
    );
  }

  const createdReturn = await getOrderReturn(database, returnId);
  return { created: true, return: createdReturn };
}
