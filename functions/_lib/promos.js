export class PromoValidationError extends Error {
  constructor(code, message, status = 409, details) {
    super(message);
    this.name = 'PromoValidationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function normalizePromoCode(value, { required = true } = {}) {
  const code = String(value || '').trim().toUpperCase();
  if (!code && !required) return '';
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
    throw new PromoValidationError(
      'INVALID_PROMO_CODE',
      'Promo code must contain 3 to 32 letters, digits, dashes or underscores',
      400,
    );
  }
  return code;
}

export function normalizePromoCartItems(sourceItems) {
  if (!Array.isArray(sourceItems) || sourceItems.length === 0) {
    throw new PromoValidationError('EMPTY_CART', 'Cart is empty', 400);
  }
  const grouped = new Map();
  for (const source of sourceItems) {
    const productKey = String(source?.productKey ?? source?.key ?? source?.sku ?? source?.id ?? '').trim().slice(0, 120);
    const quantity = Number(source?.quantity ?? source?.q);
    if (!productKey || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new PromoValidationError(
        'INVALID_CART_ITEM',
        'Each cart item must have a product key and quantity from 1 to 99',
        400,
      );
    }
    grouped.set(productKey, (grouped.get(productKey) || 0) + quantity);
  }
  const items = [...grouped.entries()].map(([productKey, quantity]) => ({ productKey, quantity }));
  if (items.length > 50 || items.reduce((sum, item) => sum + item.quantity, 0) > 200) {
    throw new PromoValidationError('CART_TOO_LARGE', 'Cart exceeds the maximum order size', 400);
  }
  return items;
}

export function pricePromoCart(items, products) {
  const byKey = new Map(products.map((product) => [product.catalog_key, product]));
  const missing = items.filter((item) => !byKey.has(item.productKey)).map((item) => item.productKey);
  if (missing.length) {
    throw new PromoValidationError(
      'PRODUCT_NOT_FOUND',
      'One or more products are unavailable',
      409,
      { productKeys: missing },
    );
  }
  let merchandiseSubtotal = 0;
  const pricedItems = items.map((item) => {
    const product = byKey.get(item.productKey);
    const unitPrice = Number(product.price);
    const lineTotal = unitPrice * item.quantity;
    merchandiseSubtotal += lineTotal;
    return {
      productId: Number(product.id),
      productKey: product.catalog_key,
      categoryId: product.category_id,
      brand: product.brand || '',
      quantity: item.quantity,
      unitPrice,
      lineTotal,
    };
  });
  return { items: pricedItems, merchandiseSubtotal };
}

export function calculatePromoDiscount({ discountType, discountValue, maxDiscount }, eligibleSubtotal) {
  const eligible = Math.max(0, Number(eligibleSubtotal) || 0);
  if (!eligible) return 0;
  let discount;
  if (discountType === 'percent') {
    // All monetary values are integer MDL. Adding 50 before integer division
    // gives deterministic round-half-up behavior for positive values.
    discount = Math.floor((eligible * Number(discountValue) + 50) / 100);
    if (maxDiscount !== null && maxDiscount !== undefined) discount = Math.min(discount, Number(maxDiscount));
  } else if (discountType === 'fixed') {
    discount = Number(discountValue);
  } else {
    throw new PromoValidationError('PROMO_CONFIGURATION_ERROR', 'Promo code configuration is invalid', 503);
  }
  return Math.max(0, Math.min(eligible, discount));
}

export function allocatePromoDiscount(items, promotion) {
  const discount = Math.max(0, Number(promotion?.discountAmount) || 0);
  if (!discount) return items.map((item) => ({ ...item, promoDiscountAllocation: 0 }));
  const scopedProducts = new Set((promotion?.productIds || []).map(Number));
  const scopedCategories = new Set(promotion?.categoryIds || []);
  const scopedBrands = new Set((promotion?.brands || []).map((brand) => String(brand).toLowerCase()));
  const hasScopes = scopedProducts.size > 0 || scopedCategories.size > 0 || scopedBrands.size > 0;
  const eligible = items.map((item, index) => ({
    index,
    item,
    eligible: !hasScopes
      || scopedProducts.has(Number(item.productId))
      || scopedCategories.has(item.categoryId)
      || scopedBrands.has(String(item.brand || '').toLowerCase()),
  })).filter((entry) => entry.eligible && Number(entry.item.lineTotal) > 0);
  const subtotal = eligible.reduce((sum, entry) => sum + Number(entry.item.lineTotal), 0);
  if (!subtotal || discount > subtotal) {
    throw new PromoValidationError('PROMO_CONFIGURATION_ERROR', 'Promo discount allocation is invalid', 503);
  }
  let allocated = 0;
  const allocations = new Map();
  const ranked = eligible.map((entry) => {
    const numerator = discount * Number(entry.item.lineTotal);
    const base = Math.floor(numerator / subtotal);
    allocated += base;
    allocations.set(entry.index, base);
    return { ...entry, remainder: numerator % subtotal };
  }).sort((left, right) => (
    right.remainder - left.remainder
      || Number(left.item.productId) - Number(right.item.productId)
      || left.index - right.index
  ));
  let remaining = discount - allocated;
  for (let index = 0; index < ranked.length && remaining > 0; index += 1, remaining -= 1) {
    const entry = ranked[index];
    allocations.set(entry.index, allocations.get(entry.index) + 1);
  }
  if (remaining !== 0) {
    throw new PromoValidationError('PROMO_CONFIGURATION_ERROR', 'Promo discount could not be allocated', 503);
  }
  return items.map((item, index) => ({
    ...item,
    promoDiscountAllocation: allocations.get(index) || 0,
  }));
}

export function cumulativePromoRefund(allocation, quantity, returnedQuantity) {
  const total = Math.max(0, Number(allocation) || 0);
  const units = Number(quantity);
  const returned = Number(returnedQuantity);
  if (!Number.isInteger(units) || units <= 0 || !Number.isInteger(returned) || returned < 0 || returned > units) {
    throw new PromoValidationError('INVALID_PROMO_REFUND', 'Promo refund quantities are invalid', 500);
  }
  const base = Math.floor(total / units);
  const remainder = total % units;
  return base * returned + Math.min(returned, remainder);
}

const activeUseSql = `released_at IS NULL`;

async function loadPromotion(db, code, userId) {
  const promo = await db.prepare(`
    SELECT pc.*,
      (SELECT COUNT(*) FROM promo_redemptions pr
       WHERE pr.promo_code_id = pc.id AND ${activeUseSql}) AS usage_count,
      (SELECT COUNT(*) FROM promo_redemptions pr
       WHERE pr.promo_code_id = pc.id AND ${activeUseSql} AND pr.user_id = ?) AS user_usage_count
    FROM promo_codes pc
    WHERE pc.code = ? COLLATE NOCASE
    LIMIT 1
  `).bind(userId || null, code).first();
  if (!promo) throw new PromoValidationError('PROMO_NOT_FOUND', 'Promo code was not found', 404);
  const [categoriesResult, productsResult, brandsResult] = await Promise.all([
    db.prepare('SELECT category_id FROM promo_code_categories WHERE promo_code_id = ?').bind(promo.id).all(),
    db.prepare('SELECT product_id FROM promo_code_products WHERE promo_code_id = ?').bind(promo.id).all(),
    db.prepare('SELECT brand FROM promo_code_brands WHERE promo_code_id = ?').bind(promo.id).all(),
  ]);
  return {
    id: promo.id,
    code: promo.code,
    discountType: promo.discount_type,
    discountValue: Number(promo.discount_value),
    maxDiscount: promo.max_discount === null ? null : Number(promo.max_discount),
    minOrderAmount: Number(promo.min_order_amount || 0),
    startsAt: promo.starts_at,
    endsAt: promo.ends_at,
    totalUseLimit: promo.total_use_limit === null ? null : Number(promo.total_use_limit),
    perUserLimit: promo.per_user_limit === null ? null : Number(promo.per_user_limit),
    isActive: Boolean(promo.is_active),
    usageCount: Number(promo.usage_count || 0),
    userUsageCount: Number(promo.user_usage_count || 0),
    categoryIds: new Set((categoriesResult.results || []).map((row) => row.category_id)),
    productIds: new Set((productsResult.results || []).map((row) => Number(row.product_id))),
    brands: new Set((brandsResult.results || []).map((row) => String(row.brand).toLowerCase())),
  };
}

export async function validatePromotion(db, options) {
  const database = typeof db.withSession === 'function' ? db.withSession('first-primary') : db;
  const code = normalizePromoCode(options?.code);
  const userId = String(options?.userId || '').trim() || null;
  const merchandiseSubtotal = Math.max(0, Number(options?.merchandiseSubtotal) || 0);
  const items = Array.isArray(options?.items) ? options.items : [];
  const now = options?.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new PromoValidationError('INVALID_PROMO_TIME', 'Promo validation time is invalid', 400);
  }
  const nowIso = now.toISOString();
  const promo = await loadPromotion(database, code, userId);
  if (!promo.isActive) throw new PromoValidationError('PROMO_INACTIVE', 'Promo code is inactive');
  if (promo.startsAt && promo.startsAt > nowIso) {
    throw new PromoValidationError('PROMO_NOT_STARTED', 'Promo code is not active yet', 409, { startsAt: promo.startsAt });
  }
  if (promo.endsAt && promo.endsAt <= nowIso) {
    throw new PromoValidationError('PROMO_EXPIRED', 'Promo code has expired', 409, { endsAt: promo.endsAt });
  }
  if (merchandiseSubtotal < promo.minOrderAmount) {
    throw new PromoValidationError(
      'PROMO_MIN_ORDER',
      'The merchandise subtotal is below the promo code minimum',
      409,
      { minimum: promo.minOrderAmount, subtotal: merchandiseSubtotal },
    );
  }
  if (promo.totalUseLimit !== null && promo.usageCount >= promo.totalUseLimit) {
    throw new PromoValidationError('PROMO_TOTAL_LIMIT_REACHED', 'Promo code usage limit has been reached');
  }
  if (promo.perUserLimit !== null && !userId) {
    throw new PromoValidationError('PROMO_LOGIN_REQUIRED', 'Sign in to use this promo code', 401);
  }
  if (promo.perUserLimit !== null && promo.userUsageCount >= promo.perUserLimit) {
    throw new PromoValidationError('PROMO_USER_LIMIT_REACHED', 'Your promo code usage limit has been reached');
  }

  const hasScopes = promo.categoryIds.size > 0 || promo.productIds.size > 0 || promo.brands.size > 0;
  const eligibleSubtotal = items.reduce((sum, item) => {
    const eligible = !hasScopes
      || promo.productIds.has(Number(item.productId))
      || promo.categoryIds.has(item.categoryId)
      || promo.brands.has(String(item.brand || '').toLowerCase());
    return sum + (eligible ? Number(item.lineTotal || 0) : 0);
  }, 0);
  const discountAmount = calculatePromoDiscount(promo, eligibleSubtotal);
  if (discountAmount <= 0) {
    throw new PromoValidationError('PROMO_NOT_APPLICABLE', 'Promo code does not apply to products in the cart');
  }
  return {
    ...promo,
    categoryIds: [...promo.categoryIds],
    productIds: [...promo.productIds],
    brands: [...promo.brands],
    merchandiseSubtotal,
    eligibleSubtotal,
    discountAmount,
    now: nowIso,
  };
}
