import { normalizePromoCode, PromoValidationError } from './promos.js';

export class AdminPromoError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'AdminPromoError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const value = (input, key, fallback) => Object.hasOwn(input || {}, key) ? input[key] : fallback;

const requiredInteger = (input, key, fallback, { min = 0, max = 10_000_000 } = {}) => {
  const raw = value(input, key, fallback);
  const number = Number(raw);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AdminPromoError('INVALID_PROMO_VALUE', `${key} must be an integer from ${min} to ${max}`, 400, { field: key });
  }
  return number;
};

const optionalInteger = (input, key, fallback, options = {}) => {
  const raw = value(input, key, fallback);
  if (raw === null || raw === undefined || raw === '') return null;
  return requiredInteger({ [key]: raw }, key, null, { min: 1, ...options });
};

const optionalDate = (input, key, fallback) => {
  const raw = value(input, key, fallback);
  if (raw === null || raw === undefined || raw === '') return null;
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw new AdminPromoError('INVALID_PROMO_DATE', `${key} must be a valid date`, 400, { field: key });
  }
  return parsed.toISOString();
};

const idList = (input, key, fallback, { numeric = false } = {}) => {
  const source = value(input, key, fallback || []);
  if (!Array.isArray(source) || source.length > 100) {
    throw new AdminPromoError('INVALID_PROMO_SCOPE', `${key} must be an array with at most 100 values`, 400, { field: key });
  }
  const normalized = source.map((entry) => numeric ? Number(entry) : String(entry || '').trim());
  if (normalized.some((entry) => numeric ? !Number.isInteger(entry) || entry <= 0 : !entry || entry.length > 100)) {
    throw new AdminPromoError('INVALID_PROMO_SCOPE', `${key} contains an invalid value`, 400, { field: key });
  }
  return [...new Set(normalized)];
};

export function normalizeAdminPromo(input, current = null) {
  let code;
  try { code = normalizePromoCode(value(input, 'code', current?.code)); }
  catch (error) {
    if (error instanceof PromoValidationError) throw new AdminPromoError(error.code, error.message, error.status, error.details);
    throw error;
  }
  const discountType = String(value(input, 'discountType', current?.discountType) || '').trim();
  if (!['percent', 'fixed'].includes(discountType)) {
    throw new AdminPromoError('INVALID_PROMO_TYPE', 'discountType must be percent or fixed');
  }
  const discountValue = requiredInteger(input, 'discountValue', current?.discountValue, {
    min: 1,
    max: discountType === 'percent' ? 100 : 10_000_000,
  });
  const maxDiscount = optionalInteger(input, 'maxDiscount', current?.maxDiscount);
  if (discountType === 'fixed' && maxDiscount !== null) {
    throw new AdminPromoError('INVALID_PROMO_MAX_DISCOUNT', 'maxDiscount is allowed only for percent promo codes');
  }
  const minOrderAmount = requiredInteger(input, 'minOrderAmount', current?.minOrderAmount ?? 0);
  const startsAt = optionalDate(input, 'startsAt', current?.startsAt);
  const endsAt = optionalDate(input, 'endsAt', current?.endsAt);
  if (startsAt && endsAt && startsAt >= endsAt) {
    throw new AdminPromoError('INVALID_PROMO_PERIOD', 'endsAt must be later than startsAt');
  }
  const totalUseLimit = optionalInteger(input, 'totalUseLimit', current?.totalUseLimit);
  const perUserLimit = optionalInteger(input, 'perUserLimit', current?.perUserLimit);
  const activeInput = value(input, 'isActive', current?.isActive ?? true);
  if (typeof activeInput !== 'boolean') throw new AdminPromoError('INVALID_PROMO_ACTIVE', 'isActive must be a boolean');
  const categoryIds = idList(input, 'categoryIds', current?.categoryIds);
  const productIds = idList(input, 'productIds', current?.productIds, { numeric: true });
  return {
    code,
    discountType,
    discountValue,
    maxDiscount,
    minOrderAmount,
    startsAt,
    endsAt,
    totalUseLimit,
    perUserLimit,
    isActive: activeInput,
    categoryIds,
    productIds,
  };
}

const number = (input) => Number(input || 0);

export const adminPromo = (row) => ({
  id: row.id,
  code: row.code,
  discountType: row.discount_type,
  discountValue: number(row.discount_value),
  maxDiscount: row.max_discount === null ? null : number(row.max_discount),
  minOrderAmount: number(row.min_order_amount),
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  totalUseLimit: row.total_use_limit === null ? null : number(row.total_use_limit),
  perUserLimit: row.per_user_limit === null ? null : number(row.per_user_limit),
  isActive: Boolean(row.is_active),
  revision: row.admin_revision || '',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  usageCount: number(row.usage_count),
  discountSum: number(row.discount_sum),
  lifetimeUsageCount: number(row.lifetime_usage_count),
  lifetimeDiscountSum: number(row.lifetime_discount_sum),
  releasedCount: number(row.released_count),
  returnAmount: number(row.return_amount),
  categoryScopeCount: number(row.category_scope_count),
  productScopeCount: number(row.product_scope_count),
});

export const ADMIN_PROMO_SELECT = `
  SELECT pc.*,
    (SELECT COUNT(*) FROM promo_redemptions pr
     WHERE pr.promo_code_id = pc.id AND pr.released_at IS NULL) AS usage_count,
    (SELECT COALESCE(SUM(pr.discount_amount), 0) FROM promo_redemptions pr
     WHERE pr.promo_code_id = pc.id AND pr.released_at IS NULL) AS discount_sum,
    (SELECT COUNT(*) FROM promo_redemptions pr
     WHERE pr.promo_code_id = pc.id) AS lifetime_usage_count,
    (SELECT COALESCE(SUM(pr.discount_amount), 0) FROM promo_redemptions pr
     WHERE pr.promo_code_id = pc.id) AS lifetime_discount_sum,
    (SELECT COUNT(*) FROM promo_redemptions pr
     WHERE pr.promo_code_id = pc.id AND pr.released_at IS NOT NULL) AS released_count,
    (SELECT COALESCE(SUM(r.items_amount - r.promo_refund_amount), 0)
     FROM promo_redemptions pr JOIN order_returns r ON r.order_id = pr.order_id
     WHERE pr.promo_code_id = pc.id) AS return_amount,
    (SELECT COUNT(*) FROM promo_code_categories scope
     WHERE scope.promo_code_id = pc.id) AS category_scope_count,
    (SELECT COUNT(*) FROM promo_code_products scope
     WHERE scope.promo_code_id = pc.id) AS product_scope_count
  FROM promo_codes pc
`;

export async function getAdminPromo(db, id) {
  const row = await db.prepare(`${ADMIN_PROMO_SELECT} WHERE pc.id = ? LIMIT 1`).bind(id).first();
  if (!row) return null;
  const [categoryResult, productResult, orderResult] = await Promise.all([
    db.prepare(`
      SELECT c.id, c.slug, c.name_ro, c.name_ru
      FROM promo_code_categories scope
      JOIN categories c ON c.id = scope.category_id
      WHERE scope.promo_code_id = ? ORDER BY c.name_ro, c.id
    `).bind(id).all(),
    db.prepare(`
      SELECT p.id, p.catalog_key, p.sku, p.name_ro, p.name_ru, p.category_id
      FROM promo_code_products scope
      JOIN products p ON p.id = scope.product_id
      WHERE scope.promo_code_id = ? ORDER BY p.name_ro, p.id
    `).bind(id).all(),
    db.prepare(`
      SELECT pr.order_id, pr.user_id, pr.discount_amount, pr.eligible_subtotal,
             pr.merchandise_subtotal, pr.created_at, pr.released_at, pr.release_reason,
             o.order_no, o.status, o.customer_name, o.total_amount,
             COALESCE((SELECT SUM(r.items_amount - r.promo_refund_amount) FROM order_returns r WHERE r.order_id = o.id), 0) AS return_amount,
             COALESCE((SELECT SUM(r.promo_refund_amount) FROM order_returns r WHERE r.order_id = o.id), 0) AS promo_refund_amount
      FROM promo_redemptions pr
      JOIN orders o ON o.id = pr.order_id
      WHERE pr.promo_code_id = ?
      ORDER BY pr.created_at DESC, pr.id DESC
      LIMIT 100
    `).bind(id).all(),
  ]);
  const promo = adminPromo(row);
  promo.categories = (categoryResult.results || []).map((category) => ({
    id: category.id,
    slug: category.slug,
    nameRo: category.name_ro,
    nameRu: category.name_ru,
  }));
  promo.products = (productResult.results || []).map((product) => ({
    id: number(product.id),
    key: product.catalog_key,
    sku: product.sku,
    nameRo: product.name_ro,
    nameRu: product.name_ru,
    categoryId: product.category_id,
  }));
  promo.categoryIds = promo.categories.map((category) => category.id);
  promo.productIds = promo.products.map((product) => product.id);
  promo.orders = (orderResult.results || []).map((order) => ({
    id: order.order_id,
    no: order.order_no,
    userId: order.user_id,
    status: order.status,
    customerName: order.customer_name,
    total: number(order.total_amount),
    discountAmount: number(order.discount_amount),
    eligibleSubtotal: number(order.eligible_subtotal),
    merchandiseSubtotal: number(order.merchandise_subtotal),
    returnAmount: number(order.return_amount),
    promoRefundAmount: number(order.promo_refund_amount),
    createdAt: order.created_at,
    releasedAt: order.released_at,
    releaseReason: order.release_reason,
  }));
  return promo;
}

export const promoSnapshot = (promo) => ({
  code: promo.code,
  discountType: promo.discountType,
  discountValue: promo.discountValue,
  maxDiscount: promo.maxDiscount,
  minOrderAmount: promo.minOrderAmount,
  startsAt: promo.startsAt,
  endsAt: promo.endsAt,
  totalUseLimit: promo.totalUseLimit,
  perUserLimit: promo.perUserLimit,
  isActive: promo.isActive,
  categoryIds: [...(promo.categoryIds || [])],
  productIds: [...(promo.productIds || [])],
});

export async function assertPromoScopes(db, draft) {
  if (draft.categoryIds.length) {
    const placeholders = draft.categoryIds.map(() => '?').join(', ');
    const result = await db.prepare(`SELECT id FROM categories WHERE id IN (${placeholders})`).bind(...draft.categoryIds).all();
    const found = new Set((result.results || []).map((row) => row.id));
    const missing = draft.categoryIds.filter((id) => !found.has(id));
    if (missing.length) throw new AdminPromoError('PROMO_CATEGORY_NOT_FOUND', 'One or more scoped categories do not exist', 409, { categoryIds: missing });
  }
  if (draft.productIds.length) {
    const placeholders = draft.productIds.map(() => '?').join(', ');
    const result = await db.prepare(`SELECT id FROM products WHERE id IN (${placeholders})`).bind(...draft.productIds).all();
    const found = new Set((result.results || []).map((row) => number(row.id)));
    const missing = draft.productIds.filter((id) => !found.has(id));
    if (missing.length) throw new AdminPromoError('PROMO_PRODUCT_NOT_FOUND', 'One or more scoped products do not exist', 409, { productIds: missing });
  }
}
