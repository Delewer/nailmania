import { apiError, handleApiError, json, readBoundedJson, requireDatabase } from '../_lib/http.js';
import { requireCustomerMutation, resolveCustomer } from '../_lib/customer-auth.js';
import { chunks, DELIVERY, normalizeOrderRequest, OrderValidationError, PAYMENT, priceOrder } from '../_lib/order-core.js';
import { catalogRevisionBump } from '../_lib/catalog-cache.js';
import { deliverTelegramNotification, logNotificationEvent } from '../_lib/notifications.js';
import { allocatePromoDiscount, PromoValidationError, validatePromotion } from '../_lib/promos.js';
import { recordProductEvent } from '../_lib/product-events.js';
import { verifyTurnstile } from '../_lib/turnstile.js';
import {
  findOrderReplay,
  fingerprintOrderRequest,
  isIdempotencyConstraint,
  normalizeOrderIdempotencyKey,
  OrderIdempotencyError,
} from '../_lib/order-idempotency.js';
import { createOrderQuote, orderQuotesEqual } from '../../shared/order-quote.js';

const placeholders = (count) => Array.from({ length: count }, () => '?').join(', ');
const MAX_ORDER_JSON_BYTES = 64 * 1024;
const primarySession = (db) => (
  typeof db.withSession === 'function' ? db.withSession('first-primary') : db
);
const orderNumber = () => {
  const timestamp = new Date().toISOString().replace(/\D/g, '').slice(2, 14);
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 4).toUpperCase();
  return `NM${timestamp}${suffix}`;
};

function inventoryUpdate(db, items, revision) {
  const cases = items.map(() => 'WHEN ? THEN ?').join(' ');
  const ids = items.map((item) => item.productId);
  const bindings = items.flatMap((item) => [item.productId, item.quantity]);
  return db.prepare(`
    UPDATE inventory
    SET reserved = reserved + CASE product_id ${cases} ELSE 0 END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        admin_revision = ?
    WHERE warehouse_id = 1 AND product_id IN (${placeholders(ids.length)})
  `).bind(...bindings, revision, ...ids);
}

function orderItemsInsert(db, orderId, items) {
  const values = items.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
  const bindings = items.flatMap((item) => [
    orderId, item.productId, item.productKey, item.sku, item.brand,
    item.name, item.categoryId, item.categoryNameRo, item.categoryNameRu,
    item.costPriceSnapshot, item.unitPrice, item.listPrice, item.quantity,
    item.promoDiscountAllocation || 0, item.lineTotal,
  ]);
  return db.prepare(`
    INSERT INTO order_items (
      order_id, product_id, product_key, sku, brand, name,
      category_id_snapshot, category_name_ro_snapshot, category_name_ru_snapshot,
      cost_price_snapshot,
      unit_price, list_price, quantity, promo_discount_allocation, line_total
    ) VALUES ${values}
  `).bind(...bindings);
}

function reservationMovementsInsert(db, orderId, items) {
  const cases = items.map(() => 'WHEN ? THEN ?').join(' ');
  const ids = items.map((item) => item.productId);
  const bindings = items.flatMap((item) => [item.productId, item.quantity]);
  return db.prepare(`
    INSERT INTO inventory_movements (
      id, product_id, warehouse_id, movement_type, delta_on_hand, delta_reserved,
      balance_on_hand, balance_reserved, order_id, reason
    )
    SELECT
      'reserve:' || ? || ':' || i.product_id,
      i.product_id, 1, 'reservation', 0,
      CASE i.product_id ${cases} ELSE 0 END,
      i.on_hand, i.reserved, ?, 'Online order reservation'
    FROM inventory i
    WHERE i.warehouse_id = 1 AND i.product_id IN (${placeholders(ids.length)})
  `).bind(orderId, ...bindings, orderId, ...ids);
}

async function loadAuthoritativeOrderQuote(db, request, userId) {
  const keys = request.items.map((item) => item.productKey);
  const productResult = await db.prepare(`
    SELECT p.id, p.catalog_key, p.sku, p.brand, p.name_ro, p.name_ru, p.category_id,
           p.price, p.old_price, p.cost_price,
           c.name_ro AS category_name_ro, c.name_ru AS category_name_ru,
           i.on_hand, i.reserved
    FROM products p
    JOIN categories c ON c.id = p.category_id
    JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
    WHERE p.is_active = 1 AND p.deleted_at IS NULL AND c.is_active = 1
      AND p.catalog_key IN (${placeholders(keys.length)})
  `).bind(...keys).all();
  const priced = priceOrder(request, productResult.results || []);
  let promotion = null;
  if (request.promoCode) {
    promotion = await validatePromotion(db, {
      code: request.promoCode,
      userId,
      items: priced.items,
      merchandiseSubtotal: priced.itemsSubtotal,
    });
    priced.items = allocatePromoDiscount(priced.items, promotion);
    priced.promoDiscount = promotion.discountAmount;
    // Delivery is based on the merchandise subtotal before promo. A promo
    // never changes the free-delivery tier.
    priced.totalAmount = Math.max(0, priced.itemsSubtotal + priced.deliveryFee - priced.promoDiscount);
  } else {
    priced.items = priced.items.map((item) => ({ ...item, promoDiscountAllocation: 0 }));
  }
  const currentQuote = createOrderQuote({
    items: priced.items,
    itemsSubtotal: priced.itemsSubtotal,
    catalogDiscount: priced.catalogDiscount,
    deliveryFee: priced.deliveryFee,
    promoCode: promotion?.code || null,
    promoDiscount: priced.promoDiscount,
    totalAmount: priced.totalAmount,
  });
  return { priced, promotion, currentQuote };
}

function buildOrderResponse({
  id, no, createdAt, reservationExpiresAt, request, priced, promotion, deliveryLabel, paymentLabel,
}) {
  return {
    id,
    no,
    date: createdAt,
    status: 'pending',
    lang: request.language,
    customer: request.customer,
    items: priced.items.map((item) => ({
      id: item.productKey,
      code: item.sku,
      brand: item.brand,
      name: item.name,
      price: item.unitPrice,
      q: item.quantity,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
    })),
    count: priced.items.reduce((sum, item) => sum + item.quantity, 0),
    discount: priced.catalogDiscount + priced.promoDiscount,
    catalogDiscount: priced.catalogDiscount,
    promoDiscount: priced.promoDiscount,
    promoCode: promotion?.code || null,
    delivery: request.delivery,
    deliveryLabel,
    deliveryFee: priced.deliveryFee,
    payment: request.payment,
    paymentLabel,
    total: priced.totalAmount,
    reservationExpiresAt,
  };
}

function publicOrderResponse(order) {
  // Contact and address data are already stored on the authoritative order.
  // Do not echo or duplicate them in the immutable idempotency response.
  const { customer: _customer, ...response } = order;
  return response;
}

async function notificationOrderPayload(db, order) {
  if (order?.customer) return order;
  const row = await db.prepare(`
    SELECT customer_name, customer_phone, customer_email, city, address, customer_comment
    FROM orders WHERE id = ? LIMIT 1
  `).bind(order.id).first();
  if (!row) throw new Error('Committed order could not be loaded for notification delivery');
  return {
    ...order,
    customer: {
      name: row.customer_name,
      phone: row.customer_phone,
      email: row.customer_email,
      city: row.city,
      address: row.address,
      comment: row.customer_comment,
    },
  };
}

async function ensureOrderNotification(context, db, order) {
  const notification = Promise.resolve()
    .then(() => notificationOrderPayload(db, order))
    .then((payload) => deliverTelegramNotification({
      db,
      env: context.env,
      order: payload,
      eventType: 'order_created',
      requestKey: `order-created:${order.id}`,
      requestId: context.data?.requestId || '',
    }))
    .catch(() => {
      logNotificationEvent({
        level: 'error',
        event: 'notification.telegram.persistence_failed',
        requestId: context.data?.requestId || '',
        channel: 'telegram',
        eventType: 'order_created',
        orderNo: order.no,
        code: 'NOTIFICATION_PERSISTENCE_FAILED',
      });
    });
  if (typeof context.waitUntil === 'function') context.waitUntil(notification);
  else await notification;
}

export async function onRequestPost(context) {
  try {
    // Guest and account checkouts share the same-origin JSON boundary. A
    // committed idempotent replay is checked only after this boundary and an
    // exact request fingerprint match, but before consuming another one-shot
    // Turnstile token.
    requireCustomerMutation(context.request, context.env);
    const body = await readBoundedJson(context.request, { maxBytes: MAX_ORDER_JSON_BYTES });
    const dbBinding = requireDatabase(context.env);
    const customerAuth = await resolveCustomer(context);
    const db = customerAuth?.db || primarySession(dbBinding);
    const idempotencyKey = normalizeOrderIdempotencyKey(context.request, body);
    const request = normalizeOrderRequest(body, { requireExpectedQuote: true });
    const requestFingerprint = await fingerprintOrderRequest(
      request,
      customerAuth?.user.id || null,
      context.env,
    );
    const replay = await findOrderReplay(db, idempotencyKey, requestFingerprint);
    if (replay) {
      await ensureOrderNotification(context, db, replay);
      return json({ ok: true, order: replay }, 201, {
        'cache-control': 'no-store',
        'idempotency-replayed': 'true',
      });
    }
    await verifyTurnstile({
      request: context.request,
      env: context.env,
      token: body?.turnstileToken,
      action: 'order',
    });
    const { priced, promotion, currentQuote } = await loadAuthoritativeOrderQuote(
      db,
      request,
      customerAuth?.user.id,
    );
    if (!orderQuotesEqual(request.expectedQuote, currentQuote)) {
      return apiError(
        'ORDER_QUOTE_CHANGED',
        'The authoritative order quote changed; review it before submitting again',
        409,
        { currentQuote },
      );
    }
    const id = crypto.randomUUID();
    const no = orderNumber();
    const createdAt = new Date().toISOString();
    const reservationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const deliveryLabel = DELIVERY[request.delivery][request.language];
    const paymentLabel = PAYMENT[request.payment][request.language];
    const notificationOrder = buildOrderResponse({
      id, no, createdAt, reservationExpiresAt, request, priced, promotion, deliveryLabel, paymentLabel,
    });
    const order = publicOrderResponse(notificationOrder);

    const statements = [db.prepare(`
      INSERT INTO orders (
        id, order_no, user_id, status, language, customer_name, customer_phone, customer_email,
        city, address, customer_comment, delivery_method, delivery_label, delivery_fee,
        payment_method, payment_label, items_subtotal, catalog_discount, promo_discount,
        total_amount, promo_code_id, reservation_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, no, customerAuth?.user.id || null,
      request.language, request.customer.name, request.customer.phone, request.customer.email,
      request.customer.city, request.customer.address, request.customer.comment,
      request.delivery, deliveryLabel, priced.deliveryFee, request.payment, paymentLabel,
      priced.itemsSubtotal, priced.catalogDiscount, priced.promoDiscount, priced.totalAmount,
      promotion?.id || null,
      reservationExpiresAt, createdAt, createdAt,
    )];
    statements.push(db.prepare(`
      INSERT INTO order_idempotency (
        idempotency_key, request_fingerprint, order_id, response_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).bind(idempotencyKey, requestFingerprint, id, JSON.stringify(order), createdAt));
    const inventoryRevision = `order:${id}:reservation`;
    for (const itemChunk of chunks(priced.items, 25)) statements.push(inventoryUpdate(db, itemChunk, inventoryRevision));
    // D1 accepts at most 100 bound parameters per statement. Each order item
    // uses 15 bindings, so six rows (90 bindings) leave a safe margin.
    for (const itemChunk of chunks(priced.items, 6)) statements.push(orderItemsInsert(db, id, itemChunk));
    if (promotion) {
      statements.push(db.prepare(`
        INSERT INTO promo_redemptions (
          promo_code_id, order_id, user_id, discount_amount, created_at,
          code_snapshot, discount_type_snapshot, discount_value_snapshot,
          eligible_subtotal, merchandise_subtotal
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        promotion.id, id, customerAuth?.user.id || null, promotion.discountAmount, createdAt,
        promotion.code, promotion.discountType, promotion.discountValue,
        promotion.eligibleSubtotal, promotion.merchandiseSubtotal,
      ));
    }
    for (const itemChunk of chunks(priced.items, 25)) statements.push(reservationMovementsInsert(db, id, itemChunk));
    statements.push(db.prepare(`
      INSERT INTO order_status_history (order_id, from_status, to_status, comment)
      VALUES (?, NULL, 'pending', 'Order created')
    `).bind(id));
    statements.push(catalogRevisionBump(db));

    try { await db.batch(statements); }
    catch (error) {
      const batchMessage = String(error?.message || error);
      // A failed primary batch can observe a commit newer than the session
      // bookmark established by the initial quote/idempotency read. Start a
      // fresh first-primary session before resolving either race so replica
      // lag cannot produce a stale quote or a false missing replay.
      let postBatchDb;
      const authoritativePostBatchDb = () => {
        postBatchDb ||= primarySession(dbBinding);
        return postBatchDb;
      };
      if (isIdempotencyConstraint(error)) {
        const committed = await findOrderReplay(
          authoritativePostBatchDb(),
          idempotencyKey,
          requestFingerprint,
        );
        if (committed) {
          await ensureOrderNotification(context, db, committed);
          return json({ ok: true, order: committed }, 201, {
            'cache-control': 'no-store',
            'idempotency-replayed': 'true',
          });
        }
      }
      if (/promo total limit reached/i.test(batchMessage)) {
        return apiError('PROMO_TOTAL_LIMIT_REACHED', 'Promo code usage limit has been reached', 409);
      }
      if (/promo user limit reached/i.test(batchMessage)) {
        return apiError('PROMO_USER_LIMIT_REACHED', 'Your promo code usage limit has been reached', 409);
      }
      if (/promo login required/i.test(batchMessage)) {
        return apiError('PROMO_LOGIN_REQUIRED', 'Sign in to use this promo code', 401);
      }
      if (/promo validation failed/i.test(batchMessage)) {
        return apiError('PROMO_CHANGED', 'Promo code conditions changed; apply it again', 409);
      }
      if (/order commercial snapshot changed/i.test(batchMessage)) {
        const refreshed = await loadAuthoritativeOrderQuote(
          authoritativePostBatchDb(),
          request,
          customerAuth?.user.id,
        );
        return apiError(
          'ORDER_QUOTE_CHANGED',
          'The authoritative order quote changed; review it before submitting again',
          409,
          { currentQuote: refreshed.currentQuote },
        );
      }
      if (/CHECK constraint failed|SQLITE_CONSTRAINT_CHECK/i.test(String(error?.message || error))) {
        return apiError('INSUFFICIENT_STOCK', 'One or more products no longer have the requested quantity', 409);
      }
      throw error;
    }

    // This conversion event is written only after the authoritative D1 batch
    // commits.  The anonymous index is derived from the random order UUID and
    // contains no customer/contact data; analytics failure never rolls back a
    // valid order.
    try {
      await recordProductEvent({
        db,
        env: context.env,
        input: {
          event: 'order_created',
          anonymousId: id,
          language: request.language,
          source: 'checkout',
          itemCount: priced.items.reduce((sum, item) => sum + item.quantity, 0),
          value: priced.totalAmount,
        },
        now: new Date(createdAt),
      });
    } catch (analyticsError) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'analytics.order_created.failed',
        orderId: id,
        code: analyticsError?.code || 'ANALYTICS_WRITE_FAILED',
      }));
    }

    await ensureOrderNotification(context, db, notificationOrder);
    return json({ ok: true, order }, 201, { 'cache-control': 'no-store' });
  } catch (error) {
    if (error instanceof OrderValidationError) {
      return apiError(error.code, error.message, error.status, error.details);
    }
    if (error instanceof PromoValidationError) {
      return apiError(error.code, error.message, error.status, error.details);
    }
    if (error instanceof OrderIdempotencyError) {
      return apiError(error.code, error.message, error.status);
    }
    return handleApiError(error);
  }
}
