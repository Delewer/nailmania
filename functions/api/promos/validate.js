import { requireCustomerMutation, resolveCustomer } from '../../_lib/customer-auth.js';
import { apiError, handleApiError, json, readBoundedJson, requireDatabase } from '../../_lib/http.js';
import {
  normalizePromoCartItems,
  pricePromoCart,
  PromoValidationError,
  validatePromotion,
} from '../../_lib/promos.js';

const placeholders = (count) => Array.from({ length: count }, () => '?').join(', ');
const MAX_PROMO_JSON_BYTES = 32 * 1024;

export async function onRequestPost(context) {
  try {
    requireCustomerMutation(context.request, context.env);
    const body = await readBoundedJson(context.request, { maxBytes: MAX_PROMO_JSON_BYTES });
    const customerAuth = await resolveCustomer(context);
    const db = customerAuth?.db || requireDatabase(context.env);
    const requestedItems = normalizePromoCartItems(body?.items);
    const keys = requestedItems.map((item) => item.productKey);
    const productResult = await db.prepare(`
      SELECT id, catalog_key, category_id, price
      FROM products
      WHERE is_active = 1 AND deleted_at IS NULL
        AND catalog_key IN (${placeholders(keys.length)})
    `).bind(...keys).all();
    const priced = pricePromoCart(requestedItems, productResult.results || []);
    const promotion = await validatePromotion(db, {
      code: body?.code,
      userId: customerAuth?.user.id,
      items: priced.items,
      merchandiseSubtotal: priced.merchandiseSubtotal,
    });
    return json({
      ok: true,
      promo: {
        code: promotion.code,
        discountType: promotion.discountType,
        discountValue: promotion.discountValue,
        maxDiscount: promotion.maxDiscount,
        merchandiseSubtotal: promotion.merchandiseSubtotal,
        eligibleSubtotal: promotion.eligibleSubtotal,
        discountAmount: promotion.discountAmount,
        merchandiseTotalAfterPromo: promotion.merchandiseSubtotal - promotion.discountAmount,
      },
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    if (error instanceof PromoValidationError) {
      return apiError(error.code, error.message, error.status, error.details);
    }
    return handleApiError(error);
  }
}
