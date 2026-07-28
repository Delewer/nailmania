import { CustomerAuthError } from './customer-auth.js';

const text = (value, max) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max + 1);
const number = (value) => Number(value || 0);

const inputValue = (input, camelName, snakeName, fallback) => {
  if (Object.hasOwn(input || {}, camelName)) return input[camelName];
  if (snakeName && Object.hasOwn(input || {}, snakeName)) return input[snakeName];
  return fallback;
};

export function normalizeAddress(input, existing = null) {
  const recipientName = text(inputValue(input, 'recipientName', 'recipient_name', existing?.recipient_name), 100);
  const phone = text(inputValue(input, 'phone', null, existing?.phone), 30);
  const city = text(inputValue(input, 'city', null, existing?.city), 120);
  const address = text(inputValue(input, 'address', null, existing?.address), 240);
  const comment = text(inputValue(input, 'comment', null, existing?.comment || ''), 500);
  const defaultInput = inputValue(input, 'isDefault', 'is_default', existing ? Boolean(existing.is_default) : false);
  if (recipientName.length < 2 || recipientName.length > 100) {
    throw new CustomerAuthError('INVALID_RECIPIENT_NAME', 'Recipient name must contain between 2 and 100 characters');
  }
  if (phone.length > 30 || phone.replace(/\D/g, '').length < 6) {
    throw new CustomerAuthError('INVALID_PHONE', 'Enter a valid phone number');
  }
  if (city.length < 2 || city.length > 120) {
    throw new CustomerAuthError('INVALID_CITY', 'City must contain between 2 and 120 characters');
  }
  if (address.length < 3 || address.length > 240) {
    throw new CustomerAuthError('INVALID_ADDRESS', 'Address must contain between 3 and 240 characters');
  }
  if (comment.length > 500) throw new CustomerAuthError('INVALID_COMMENT', 'Comment is too long');
  if (typeof defaultInput !== 'boolean') {
    throw new CustomerAuthError('INVALID_DEFAULT_ADDRESS', 'isDefault must be a boolean');
  }
  return { recipientName, phone, city, address, comment, isDefault: defaultInput };
}

export const publicAddress = (row) => ({
  id: row.id,
  recipientName: row.recipient_name,
  phone: row.phone,
  city: row.city,
  address: row.address,
  comment: row.comment || '',
  isDefault: Boolean(row.is_default),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const customerOrderSummary = (row) => ({
  id: row.id,
  no: row.order_no,
  status: row.status,
  language: row.language,
  deliveryMethod: row.delivery_method,
  deliveryLabel: row.delivery_label,
  paymentMethod: row.payment_method,
  paymentLabel: row.payment_label,
  itemCount: number(row.item_count),
  lineCount: number(row.line_count),
  itemsSubtotal: number(row.items_subtotal),
  catalogDiscount: number(row.catalog_discount),
  promoDiscount: number(row.promo_discount),
  promoCode: row.promo_code || null,
  deliveryFee: number(row.delivery_fee),
  total: number(row.total_amount),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  reservationExpiresAt: row.reservation_expires_at,
});

export async function getCustomerOrder(db, userId, id) {
  const order = await db.prepare(`
    SELECT o.*, COALESCE(pr.code_snapshot, pc.code) AS promo_code
    FROM orders o
    LEFT JOIN promo_redemptions pr ON pr.order_id = o.id
    LEFT JOIN promo_codes pc ON pc.id = o.promo_code_id
    WHERE o.user_id = ? AND (o.id = ? OR o.order_no = ?)
    LIMIT 1
  `).bind(userId, id, id).first();
  if (!order) return null;
  const [itemsResult, historyResult] = await Promise.all([
    db.prepare(`
      SELECT id, product_id, product_key, sku, brand, name, unit_price, list_price,
             quantity, sold_quantity, returned_quantity, line_total
      FROM order_items
      WHERE order_id = ?
      ORDER BY id
    `).bind(order.id).all(),
    db.prepare(`
      SELECT id, from_status, to_status, created_at
      FROM order_status_history
      WHERE order_id = ?
      ORDER BY id
    `).bind(order.id).all(),
  ]);
  const items = (itemsResult.results || []).map((item) => ({
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
    lineTotal: number(item.line_total),
  }));
  return {
    ...customerOrderSummary({
      ...order,
      item_count: items.reduce((sum, item) => sum + item.quantity, 0),
      line_count: items.length,
    }),
    customer: {
      name: order.customer_name,
      phone: order.customer_phone,
      email: order.customer_email,
      city: order.city,
      address: order.address,
      comment: order.customer_comment,
    },
    items,
    history: (historyResult.results || []).map((entry) => ({
      id: entry.id,
      fromStatus: entry.from_status,
      toStatus: entry.to_status,
      createdAt: entry.created_at,
    })),
  };
}
