import { catalogRevisionBump } from './catalog-cache.js';

export const ORDER_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['confirmed', 'cancelled']),
  confirmed: Object.freeze(['processing', 'cancelled']),
  processing: Object.freeze(['ready', 'cancelled']),
  ready: Object.freeze(['shipped', 'completed', 'cancelled']),
  shipped: Object.freeze(['completed']),
  completed: Object.freeze(['returned']),
  cancelled: Object.freeze([]),
  returned: Object.freeze([]),
});

export class OrderLifecycleError extends Error {
  constructor(code, message, status = 409, details) {
    super(message);
    this.name = 'OrderLifecycleError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const safeText = (value, max = 1000) => String(value || '').trim().slice(0, max);

export function transitionPlan(fromStatus, toStatus) {
  const allowed = ORDER_TRANSITIONS[fromStatus];
  if (!allowed) throw new OrderLifecycleError('INVALID_ORDER_STATUS', `Unknown order status: ${fromStatus}`, 400);
  if (fromStatus === toStatus) return { action: 'none', idempotent: true };
  if (!allowed.includes(toStatus)) {
    throw new OrderLifecycleError(
      'INVALID_STATUS_TRANSITION',
      `Order cannot move from ${fromStatus} to ${toStatus}`,
      409,
      { fromStatus, toStatus, allowed },
    );
  }
  if (toStatus === 'cancelled') return { action: 'release', idempotent: false };
  if (toStatus === 'completed') return { action: 'sale', idempotent: false };
  if (toStatus === 'returned') return { action: 'return', idempotent: false };
  return { action: 'none', idempotent: false };
}

const transitionGuard = `
  EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = ? AND o.status = ? AND o.transition_token = ?
  )
`;

const inventoryRevision = (token, action) => `order:${token}:${action}`;

function releaseStatements(db, orderId, toStatus, token, now, actorUserId, reason) {
  return [
    db.prepare(`
      UPDATE inventory
      SET reserved = reserved - (
            SELECT oi.quantity FROM order_items oi
            WHERE oi.order_id = ? AND oi.product_id = inventory.product_id
          ),
          updated_at = ?,
          admin_revision = ?
      WHERE warehouse_id = 1
        AND EXISTS (
          SELECT 1 FROM order_items oi
          WHERE oi.order_id = ? AND oi.product_id = inventory.product_id
        )
        AND ${transitionGuard}
    `).bind(orderId, now, inventoryRevision(token, 'release'), orderId, orderId, toStatus, token),
    db.prepare(`
      INSERT INTO inventory_movements (
        id, product_id, warehouse_id, movement_type, delta_on_hand, delta_reserved,
        balance_on_hand, balance_reserved, order_id, actor_user_id, reason, created_at
      )
      SELECT
        'release:' || ? || ':' || i.product_id,
        i.product_id, 1, 'reservation_release', 0, -oi.quantity,
        i.on_hand, i.reserved, ?, ?, ?, ?
      FROM order_items oi
      JOIN inventory i ON i.product_id = oi.product_id AND i.warehouse_id = 1
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.order_id = ? AND o.status = ? AND o.transition_token = ?
      ON CONFLICT(id) DO NOTHING
    `).bind(orderId, orderId, actorUserId, reason, now, orderId, toStatus, token),
    db.prepare(`
      UPDATE promo_redemptions
      SET released_at = ?, release_reason = ?
      WHERE order_id = ? AND released_at IS NULL
        AND ${transitionGuard}
    `).bind(now, reason, orderId, orderId, toStatus, token),
    catalogRevisionBump(db, transitionGuard, [orderId, toStatus, token]),
  ];
}

function saleStatements(db, orderId, toStatus, token, now, actorUserId, reason) {
  return [
    db.prepare(`
      UPDATE inventory
      SET on_hand = on_hand - (
            SELECT oi.quantity FROM order_items oi
            WHERE oi.order_id = ? AND oi.product_id = inventory.product_id
          ),
          reserved = reserved - (
            SELECT oi.quantity FROM order_items oi
            WHERE oi.order_id = ? AND oi.product_id = inventory.product_id
          ),
          updated_at = ?,
          admin_revision = ?
      WHERE warehouse_id = 1
        AND EXISTS (
          SELECT 1 FROM order_items oi
          WHERE oi.order_id = ? AND oi.product_id = inventory.product_id
        )
        AND ${transitionGuard}
    `).bind(orderId, orderId, now, inventoryRevision(token, 'sale'), orderId, orderId, toStatus, token),
    db.prepare(`
      INSERT INTO inventory_movements (
        id, product_id, warehouse_id, movement_type, delta_on_hand, delta_reserved,
        balance_on_hand, balance_reserved, order_id, actor_user_id, reason, created_at
      )
      SELECT
        'sale:' || ? || ':' || i.product_id,
        i.product_id, 1, 'sale', -oi.quantity, -oi.quantity,
        i.on_hand, i.reserved, ?, ?, ?, ?
      FROM order_items oi
      JOIN inventory i ON i.product_id = oi.product_id AND i.warehouse_id = 1
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.order_id = ? AND o.status = ? AND o.transition_token = ?
      ON CONFLICT(id) DO NOTHING
    `).bind(orderId, orderId, actorUserId, reason, now, orderId, toStatus, token),
    db.prepare(`
      UPDATE order_items
      SET sold_quantity = quantity
      WHERE order_id = ? AND ${transitionGuard}
    `).bind(orderId, orderId, toStatus, token),
    catalogRevisionBump(db, transitionGuard, [orderId, toStatus, token]),
  ];
}

function returnStatements(db, orderId, toStatus, token, now, actorUserId, reason) {
  return [
    db.prepare(`
      INSERT INTO order_returns (
        id, order_id, request_key, request_fingerprint, return_kind,
        items_amount, promo_refund_amount, reason, actor_user_id, created_at
      )
      SELECT
        'full-return:' || ?, o.id, 'status:' || ?, ?, 'full',
        COALESCE((
          SELECT SUM((oi.sold_quantity - oi.returned_quantity) * oi.unit_price)
          FROM order_items oi WHERE oi.order_id = o.id
        ), 0),
        COALESCE((
          SELECT SUM(
            oi.promo_discount_allocation - COALESCE((
              SELECT SUM(ri.promo_refund_amount)
              FROM order_return_items ri WHERE ri.order_item_id = oi.id
            ), 0)
          )
          FROM order_items oi
          WHERE oi.order_id = o.id AND oi.sold_quantity > oi.returned_quantity
        ), 0),
        ?, ?, ?
      FROM orders o
      WHERE o.id = ? AND o.status = ? AND o.transition_token = ?
      ON CONFLICT(order_id, request_key) DO NOTHING
    `).bind(token, token, token, reason, actorUserId, now, orderId, toStatus, token),
    db.prepare(`
      INSERT INTO order_return_items (
        return_id, order_item_id, product_id, quantity, unit_price, line_amount,
        promo_refund_amount
      )
      SELECT
        'full-return:' || ?, oi.id, oi.product_id,
        oi.sold_quantity - oi.returned_quantity, oi.unit_price,
        (oi.sold_quantity - oi.returned_quantity) * oi.unit_price,
        oi.promo_discount_allocation - COALESCE((
          SELECT SUM(previous.promo_refund_amount)
          FROM order_return_items previous WHERE previous.order_item_id = oi.id
        ), 0)
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.order_id = ?
        AND oi.sold_quantity > oi.returned_quantity
        AND o.status = ? AND o.transition_token = ?
      ON CONFLICT(return_id, order_item_id) DO NOTHING
    `).bind(token, orderId, toStatus, token),
    db.prepare(`
      UPDATE inventory
      SET on_hand = on_hand + (
            SELECT oi.sold_quantity - oi.returned_quantity FROM order_items oi
            WHERE oi.order_id = ? AND oi.product_id = inventory.product_id
          ),
          updated_at = ?,
          admin_revision = ?
      WHERE warehouse_id = 1
        AND EXISTS (
          SELECT 1 FROM order_items oi
          WHERE oi.order_id = ? AND oi.product_id = inventory.product_id
            AND oi.sold_quantity > oi.returned_quantity
        )
        AND ${transitionGuard}
    `).bind(orderId, now, inventoryRevision(token, 'return'), orderId, orderId, toStatus, token),
    db.prepare(`
      INSERT INTO inventory_movements (
        id, product_id, warehouse_id, movement_type, delta_on_hand, delta_reserved,
        balance_on_hand, balance_reserved, order_id, actor_user_id, reason, created_at
      )
      SELECT
        'return:' || ? || ':' || i.product_id,
        i.product_id, 1, 'return', oi.sold_quantity - oi.returned_quantity, 0,
        i.on_hand, i.reserved, ?, ?, ?, ?
      FROM order_items oi
      JOIN inventory i ON i.product_id = oi.product_id AND i.warehouse_id = 1
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.order_id = ? AND oi.sold_quantity > oi.returned_quantity
        AND o.status = ? AND o.transition_token = ?
      ON CONFLICT(id) DO NOTHING
    `).bind(orderId, orderId, actorUserId, reason, now, orderId, toStatus, token),
    db.prepare(`
      UPDATE order_items
      SET returned_quantity = sold_quantity
      WHERE order_id = ? AND ${transitionGuard}
    `).bind(orderId, orderId, toStatus, token),
    catalogRevisionBump(db, transitionGuard, [orderId, toStatus, token]),
  ];
}

const lifecycleStatements = (db, action, args) => {
  if (action === 'release') return releaseStatements(db, ...args);
  if (action === 'sale') return saleStatements(db, ...args);
  if (action === 'return') return returnStatements(db, ...args);
  return [];
};

const changedRows = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

export async function transitionOrder(db, options) {
  const database = typeof db.withSession === 'function' ? db.withSession('first-primary') : db;
  const orderId = safeText(options?.orderId, 120);
  const toStatus = safeText(options?.toStatus, 30);
  const actorUserId = safeText(options?.actorUserId, 120) || null;
  const comment = safeText(options?.comment, 1000);
  const now = options?.now ? new Date(options.now).toISOString() : new Date().toISOString();
  if (!orderId || !toStatus) throw new OrderLifecycleError('INVALID_TRANSITION_REQUEST', 'Order id and target status are required', 400);

  const order = await database.prepare(`
    SELECT id, order_no, status, reservation_expires_at
    FROM orders WHERE id = ?
  `).bind(orderId).first();
  if (!order) throw new OrderLifecycleError('ORDER_NOT_FOUND', 'Order not found', 404, { orderId });

  const plan = transitionPlan(order.status, toStatus);
  if (plan.idempotent) {
    return { changed: false, orderId, orderNo: order.order_no, fromStatus: order.status, toStatus, action: plan.action };
  }

  const token = crypto.randomUUID();
  const reason = comment || ({
    release: 'Order reservation released',
    sale: 'Order completed and stock sold',
    return: 'Full order return',
  }[plan.action] || `Order status changed to ${toStatus}`);
  const statusStatement = database.prepare(`
    UPDATE orders
    SET status = ?,
        reservation_expires_at = NULL,
        confirmed_at = CASE WHEN ? = 'confirmed' THEN COALESCE(confirmed_at, ?) ELSE confirmed_at END,
        completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE completed_at END,
        cancelled_at = CASE WHEN ? = 'cancelled' THEN COALESCE(cancelled_at, ?) ELSE cancelled_at END,
        transition_token = ?,
        updated_at = ?
    WHERE id = ? AND status = ?
  `).bind(toStatus, toStatus, now, toStatus, now, toStatus, now, token, now, orderId, order.status);

  const statements = [statusStatement];
  statements.push(...lifecycleStatements(database, plan.action, [orderId, toStatus, token, now, actorUserId, reason]));
  statements.push(database.prepare(`
    INSERT INTO order_status_history (
      order_id, from_status, to_status, actor_user_id, comment, created_at, transition_token
    )
    SELECT id, ?, ?, ?, ?, ?, ? FROM orders
    WHERE id = ? AND status = ? AND transition_token = ?
  `).bind(order.status, toStatus, actorUserId, comment, now, token, orderId, toStatus, token));
  statements.push(database.prepare(`
    INSERT INTO admin_audit_log (
      id, actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at
    )
    SELECT 'audit:' || ?, ?, 'order.status.change', 'order', id,
           json_object('status', ?), json_object('status', ?), ?
    FROM orders WHERE id = ? AND status = ? AND transition_token = ?
  `).bind(token, actorUserId, order.status, toStatus, now, orderId, toStatus, token));

  let results;
  try {
    results = await database.batch(statements);
  } catch (error) {
    if (/CHECK constraint failed|SQLITE_CONSTRAINT_CHECK/i.test(String(error?.message || error))) {
      throw new OrderLifecycleError(
        'INVENTORY_STATE_CONFLICT',
        'Inventory no longer matches the order reservation',
        409,
        { orderId, fromStatus: order.status, toStatus },
      );
    }
    throw error;
  }

  if (changedRows(results?.[0]) === 0) {
    const current = await database.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first();
    if (current?.status === toStatus) {
      return { changed: false, orderId, orderNo: order.order_no, fromStatus: current.status, toStatus, action: plan.action };
    }
    throw new OrderLifecycleError('ORDER_STATUS_CONFLICT', 'Order status changed concurrently', 409, {
      orderId,
      expectedStatus: order.status,
      currentStatus: current?.status,
    });
  }

  return {
    changed: true,
    orderId,
    orderNo: order.order_no,
    fromStatus: order.status,
    toStatus,
    action: plan.action,
    transitionToken: token,
  };
}

export async function releaseExpiredReservations(db, options = {}) {
  const database = typeof db.withSession === 'function' ? db.withSession('first-primary') : db;
  const now = options.now ? new Date(options.now).toISOString() : new Date().toISOString();
  const limit = Math.min(250, Math.max(1, Number(options.limit) || 100));
  const result = await database.prepare(`
    SELECT id FROM orders
    WHERE status = 'pending'
      AND reservation_expires_at IS NOT NULL
      AND reservation_expires_at <= ?
    ORDER BY reservation_expires_at, id
    LIMIT ?
  `).bind(now, limit).all();
  const orders = result.results || [];
  const summary = { checkedAt: now, selected: orders.length, released: 0, skipped: 0, errors: [] };

  for (const order of orders) {
    try {
      const transition = await transitionOrder(database, {
        orderId: order.id,
        toStatus: 'cancelled',
        comment: 'Reservation expired automatically',
        now,
      });
      if (transition.changed) summary.released += 1;
      else summary.skipped += 1;
    } catch (error) {
      if (error instanceof OrderLifecycleError && error.code === 'ORDER_STATUS_CONFLICT') summary.skipped += 1;
      else summary.errors.push({ orderId: order.id, code: error?.code || 'RELEASE_FAILED', message: error?.message || String(error) });
    }
  }
  return summary;
}
