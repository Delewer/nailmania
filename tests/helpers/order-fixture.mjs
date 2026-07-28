import { createOrderQuote } from '../../shared/order-quote.js';
import { calculateDeliveryFee } from '../../shared/order-rules.js';
import { calculatePromoDiscount } from '../../functions/_lib/promos.js';

const sqliteDatabase = (db) => db?.sqlite || db?.db?.sqlite;

export function withOrderContract(db, input, { idempotencyKey = crypto.randomUUID() } = {}) {
  const sqlite = sqliteDatabase(db);
  if (!sqlite) throw new TypeError('Order fixture requires a SqliteD1-backed database');
  const body = { ...input };
  const items = (body.items || []).map((requested) => {
    const product = sqlite.prepare(`
      SELECT id, catalog_key, category_id, price, old_price
      FROM products WHERE catalog_key = ?
    `).get(requested.productKey);
    if (!product) throw new TypeError(`Unknown fixture product: ${requested.productKey}`);
    const quantity = Number(requested.quantity);
    const unitPrice = Number(product.price);
    const listPrice = Number(product.old_price) > unitPrice ? Number(product.old_price) : unitPrice;
    return {
      productId: Number(product.id),
      productKey: product.catalog_key,
      categoryId: product.category_id,
      quantity,
      unitPrice,
      listPrice,
      lineTotal: unitPrice * quantity,
    };
  });
  const itemsSubtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const catalogDiscount = items.reduce(
    (sum, item) => sum + (item.listPrice - item.unitPrice) * item.quantity,
    0,
  );
  const promoCode = String(body.promoCode || '').trim().toUpperCase();
  let promoDiscount = 0;
  if (promoCode) {
    const promo = sqlite.prepare('SELECT * FROM promo_codes WHERE code = ? COLLATE NOCASE').get(promoCode);
    if (!promo) throw new TypeError(`Unknown fixture promo: ${promoCode}`);
    const productScopes = new Set(sqlite.prepare(
      'SELECT product_id FROM promo_code_products WHERE promo_code_id = ?',
    ).all(promo.id).map((row) => Number(row.product_id)));
    const categoryScopes = new Set(sqlite.prepare(
      'SELECT category_id FROM promo_code_categories WHERE promo_code_id = ?',
    ).all(promo.id).map((row) => row.category_id));
    const hasScopes = productScopes.size > 0 || categoryScopes.size > 0;
    const eligibleSubtotal = items.reduce((sum, item) => sum + (
      !hasScopes || productScopes.has(item.productId) || categoryScopes.has(item.categoryId)
        ? item.lineTotal
        : 0
    ), 0);
    promoDiscount = calculatePromoDiscount({
      discountType: promo.discount_type,
      discountValue: Number(promo.discount_value),
      maxDiscount: promo.max_discount == null ? null : Number(promo.max_discount),
    }, eligibleSubtotal);
  }
  const deliveryFee = calculateDeliveryFee(body.delivery, itemsSubtotal);
  return {
    ...body,
    idempotencyKey,
    expectedQuote: createOrderQuote({
      items,
      itemsSubtotal,
      catalogDiscount,
      deliveryFee,
      promoCode: promoCode || null,
      promoDiscount,
      totalAmount: Math.max(0, itemsSubtotal + deliveryFee - promoDiscount),
    }),
  };
}
