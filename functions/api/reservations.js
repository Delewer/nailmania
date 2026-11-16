import { requireCustomerMutation } from '../_lib/customer-auth.js';
import { apiError, handleApiError, json, readBoundedJson, requireDatabase } from '../_lib/http.js';

const MAX_CART_JSON_BYTES = 8 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const cartId = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID.test(normalized)) throw new TypeError('INVALID_CART_ID');
  return normalized;
};

// Compatibility endpoint for storefront tabs that were opened before the
// no-cart-reservation release. It never mutates inventory. Current clients keep
// their cart locally and reserve stock only in POST /api/orders.
export async function onRequestGet(context) {
  try {
    cartId(new URL(context.request.url).searchParams.get('cartId'));
    return json({ ok: true, reservations: [] }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    if (error instanceof TypeError && error.message === 'INVALID_CART_ID') {
      return apiError('INVALID_CART_ID', 'A valid cart id is required', 400);
    }
    return handleApiError(error);
  }
}

export async function onRequestPost(context) {
  try {
    requireCustomerMutation(context.request, context.env);
    const body = await readBoundedJson(context.request, {
      maxBytes: MAX_CART_JSON_BYTES,
      requireObject: true,
    });
    const normalizedCartId = cartId(body.cartId);
    const productKey = String(body.productKey || '').trim().slice(0, 120);
    const quantity = Number(body.quantity);
    if (!productKey) return apiError('INVALID_PRODUCT_ID', 'Product id is required', 400);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) {
      return apiError('INVALID_CART_QUANTITY', 'Quantity must be an integer from 0 to 99', 400);
    }
    const product = await requireDatabase(context.env).prepare(`
      SELECT p.id, p.catalog_key, MAX(0, i.on_hand - i.reserved) AS available
      FROM products p
      JOIN categories c ON c.id = p.category_id AND c.is_active = 1
      JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
      WHERE p.catalog_key = ? AND p.is_active = 1 AND p.deleted_at IS NULL
      LIMIT 1
    `).bind(productKey).first();
    if (!product) return apiError('PRODUCT_NOT_FOUND', 'Product is unavailable', 404);
    const available = Number(product.available || 0);
    if (quantity > available) {
      return apiError('INSUFFICIENT_STOCK', 'The requested quantity is no longer available', 409, {
        productKey: product.catalog_key,
        requested: quantity,
        available,
      });
    }
    return json({
      ok: true,
      reservation: {
        id: null,
        cartId: normalizedCartId,
        productId: Number(product.id),
        productKey: product.catalog_key,
        quantity,
        status: quantity > 0 ? 'CART_ONLY' : 'CANCELLED',
        expiresAt: null,
        available,
      },
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    if (error instanceof TypeError && error.message === 'INVALID_CART_ID') {
      return apiError('INVALID_CART_ID', 'A valid cart id is required', 400);
    }
    return handleApiError(error);
  }
}
