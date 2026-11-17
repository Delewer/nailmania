const number = (value) => Number(value || 0);

export async function getOrderCustomerPayload(db, orderId, options = {}) {
  const order = await db.prepare(`
    SELECT id, order_no, user_id, language, customer_name, customer_email,
           city, address, delivery_label, payment_label, items_subtotal,
           catalog_discount, promo_discount, delivery_fee, total_amount, created_at
    FROM orders
    WHERE id = ?
    LIMIT 1
  `).bind(orderId).first();
  if (!order) return null;

  const itemsResult = await db.prepare(`
    SELECT id, name, quantity, line_total
    FROM order_items
    WHERE order_id = ?
    ORDER BY id
  `).bind(order.id).all();

  let orderReturn = null;
  const returnId = String(options.returnId || '').trim();
  if (returnId) {
    const returnRow = await db.prepare(`
      SELECT id, items_amount, promo_refund_amount, created_at
      FROM order_returns
      WHERE id = ? AND order_id = ?
      LIMIT 1
    `).bind(returnId, order.id).first();
    if (!returnRow) return null;
    const returnItemsResult = await db.prepare(`
      SELECT ri.id, oi.name, ri.quantity, ri.line_amount, ri.promo_refund_amount
      FROM order_return_items ri
      JOIN order_items oi ON oi.id = ri.order_item_id
      WHERE ri.return_id = ?
      ORDER BY ri.id
    `).bind(returnId).all();
    orderReturn = {
      id: returnRow.id,
      refundAmount: number(returnRow.items_amount) - number(returnRow.promo_refund_amount),
      createdAt: returnRow.created_at,
      items: (returnItemsResult.results || []).map((item) => ({
        id: item.id,
        name: item.name,
        quantity: number(item.quantity),
        lineTotal: number(item.line_amount) - number(item.promo_refund_amount),
      })),
    };
  }

  return {
    id: order.id,
    no: order.order_no,
    userId: order.user_id || null,
    lang: order.language === 'ru' ? 'ru' : 'ro',
    createdAt: order.created_at,
    customer: {
      name: order.customer_name,
      email: order.customer_email,
      city: order.city,
      address: order.address,
    },
    items: (itemsResult.results || []).map((item) => ({
      id: item.id,
      name: item.name,
      quantity: number(item.quantity),
      lineTotal: number(item.line_total),
    })),
    discount: number(order.catalog_discount) + number(order.promo_discount),
    catalogDiscount: number(order.catalog_discount),
    promoDiscount: number(order.promo_discount),
    deliveryFee: number(order.delivery_fee),
    total: number(order.total_amount),
    deliveryLabel: order.delivery_label,
    paymentLabel: order.payment_label,
    return: orderReturn,
  };
}
