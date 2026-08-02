export class AdminDiscountError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'AdminDiscountError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const value = (input, key, fallback) => Object.hasOwn(input || {}, key) ? input[key] : fallback;
const number = (input) => Number(input || 0);

const optionalDate = (input, key, fallback) => {
  const raw = value(input, key, fallback);
  if (raw === null || raw === undefined || raw === '') return null;
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw new AdminDiscountError('INVALID_DISCOUNT_DATE', `${key} must be a valid date`, 400, { field: key });
  }
  return parsed.toISOString();
};

const scopeList = (input, key, fallback, { numeric = false, maxLength = 180 } = {}) => {
  const source = value(input, key, fallback || []);
  if (!Array.isArray(source) || source.length > 100) {
    throw new AdminDiscountError(
      'INVALID_DISCOUNT_SCOPE',
      `${key} must be an array with at most 100 values`,
      400,
      { field: key },
    );
  }
  const normalized = source.map((entry) => numeric ? Number(entry) : String(entry || '').trim());
  if (normalized.some((entry) => numeric
    ? !Number.isInteger(entry) || entry <= 0
    : !entry || entry.length > maxLength)) {
    throw new AdminDiscountError('INVALID_DISCOUNT_SCOPE', `${key} contains an invalid value`, 400, { field: key });
  }
  if (numeric) return [...new Set(normalized)];
  const seen = new Set();
  return normalized.filter((entry) => {
    const folded = entry.toLowerCase();
    if (seen.has(folded)) return false;
    seen.add(folded);
    return true;
  });
};

export function normalizeAdminDiscount(input, current = null) {
  const name = String(value(input, 'name', current?.name) || '').trim();
  if (!name || name.length > 180) {
    throw new AdminDiscountError('INVALID_DISCOUNT_NAME', 'name must contain from 1 to 180 characters', 400, { field: 'name' });
  }
  const percentage = Number(value(input, 'percentage', current?.percentage));
  if (!Number.isInteger(percentage) || percentage < 1 || percentage > 99) {
    throw new AdminDiscountError('INVALID_DISCOUNT_PERCENTAGE', 'percentage must be an integer from 1 to 99', 400, { field: 'percentage' });
  }
  const startsAt = optionalDate(input, 'startsAt', current?.startsAt);
  const endsAt = optionalDate(input, 'endsAt', current?.endsAt);
  if (startsAt && endsAt && startsAt >= endsAt) {
    throw new AdminDiscountError('INVALID_DISCOUNT_PERIOD', 'endsAt must be later than startsAt');
  }
  const activeInput = value(input, 'isActive', current?.isActive ?? true);
  if (typeof activeInput !== 'boolean') {
    throw new AdminDiscountError('INVALID_DISCOUNT_ACTIVE', 'isActive must be a boolean', 400, { field: 'isActive' });
  }
  const categoryIds = scopeList(input, 'categoryIds', current?.categoryIds, { maxLength: 100 });
  const productIds = scopeList(input, 'productIds', current?.productIds, { numeric: true });
  const brands = scopeList(input, 'brands', current?.brands, { maxLength: 180 });
  if (!categoryIds.length && !productIds.length && !brands.length) {
    throw new AdminDiscountError(
      'DISCOUNT_SCOPE_REQUIRED',
      'Select at least one product, category or brand',
      400,
    );
  }
  return {
    name,
    percentage,
    startsAt,
    endsAt,
    isActive: activeInput,
    categoryIds,
    productIds,
    brands,
  };
}

export const adminDiscount = (row) => ({
  id: row.id,
  name: row.name,
  percentage: number(row.percentage),
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  isActive: Boolean(row.is_active),
  revision: row.admin_revision || '',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  productScopeCount: number(row.product_scope_count),
  categoryScopeCount: number(row.category_scope_count),
  brandScopeCount: number(row.brand_scope_count),
  affectedProductCount: number(row.affected_product_count),
});

export const ADMIN_DISCOUNT_SELECT = `
  SELECT discount.*,
    (SELECT COUNT(*) FROM catalog_discount_products scope
     WHERE scope.catalog_discount_id = discount.id) AS product_scope_count,
    (SELECT COUNT(*) FROM catalog_discount_categories scope
     WHERE scope.catalog_discount_id = discount.id) AS category_scope_count,
    (SELECT COUNT(*) FROM catalog_discount_brands scope
     WHERE scope.catalog_discount_id = discount.id) AS brand_scope_count,
    (SELECT COUNT(*) FROM products product
     WHERE product.is_active = 1 AND product.deleted_at IS NULL AND (
       EXISTS (SELECT 1 FROM catalog_discount_products scope
               WHERE scope.catalog_discount_id = discount.id AND scope.product_id = product.id)
       OR EXISTS (SELECT 1 FROM catalog_discount_categories scope
                  WHERE scope.catalog_discount_id = discount.id AND scope.category_id = product.category_id)
       OR EXISTS (SELECT 1 FROM catalog_discount_brands scope
                  WHERE scope.catalog_discount_id = discount.id AND scope.brand = product.brand COLLATE NOCASE)
     )) AS affected_product_count
  FROM catalog_discounts discount
`;

export async function getAdminDiscount(db, id) {
  const row = await db.prepare(`${ADMIN_DISCOUNT_SELECT} WHERE discount.id = ? LIMIT 1`).bind(id).first();
  if (!row) return null;
  const [categoryResult, productResult, brandResult] = await Promise.all([
    db.prepare(`
      SELECT category.id, category.slug, category.name_ro, category.name_ru
      FROM catalog_discount_categories scope
      JOIN categories category ON category.id = scope.category_id
      WHERE scope.catalog_discount_id = ?
      ORDER BY category.name_ro, category.id
    `).bind(id).all(),
    db.prepare(`
      SELECT product.id, product.catalog_key, product.sku, product.name_ro,
             product.name_ru, product.category_id, product.brand
      FROM catalog_discount_products scope
      JOIN products product ON product.id = scope.product_id
      WHERE scope.catalog_discount_id = ?
      ORDER BY product.name_ro, product.id
    `).bind(id).all(),
    db.prepare(`
      SELECT brand FROM catalog_discount_brands
      WHERE catalog_discount_id = ? ORDER BY brand COLLATE NOCASE
    `).bind(id).all(),
  ]);
  const discount = adminDiscount(row);
  discount.categories = (categoryResult.results || []).map((category) => ({
    id: category.id,
    slug: category.slug,
    nameRo: category.name_ro,
    nameRu: category.name_ru,
  }));
  discount.products = (productResult.results || []).map((product) => ({
    id: number(product.id),
    key: product.catalog_key,
    sku: product.sku,
    nameRo: product.name_ro,
    nameRu: product.name_ru,
    categoryId: product.category_id,
    brand: product.brand,
  }));
  discount.brands = (brandResult.results || []).map((entry) => entry.brand);
  discount.categoryIds = discount.categories.map((category) => category.id);
  discount.productIds = discount.products.map((product) => product.id);
  return discount;
}

export const discountSnapshot = (discount) => ({
  name: discount.name,
  percentage: discount.percentage,
  startsAt: discount.startsAt,
  endsAt: discount.endsAt,
  isActive: discount.isActive,
  categoryIds: [...(discount.categoryIds || [])],
  productIds: [...(discount.productIds || [])],
  brands: [...(discount.brands || [])],
});

export async function assertDiscountScopes(db, draft) {
  if (draft.categoryIds.length) {
    const placeholders = draft.categoryIds.map(() => '?').join(', ');
    const result = await db.prepare(`SELECT id FROM categories WHERE id IN (${placeholders})`).bind(...draft.categoryIds).all();
    const found = new Set((result.results || []).map((row) => row.id));
    const missing = draft.categoryIds.filter((id) => !found.has(id));
    if (missing.length) {
      throw new AdminDiscountError('DISCOUNT_CATEGORY_NOT_FOUND', 'One or more scoped categories do not exist', 409, { categoryIds: missing });
    }
  }
  if (draft.productIds.length) {
    const placeholders = draft.productIds.map(() => '?').join(', ');
    const result = await db.prepare(`SELECT id FROM products WHERE id IN (${placeholders})`).bind(...draft.productIds).all();
    const found = new Set((result.results || []).map((row) => number(row.id)));
    const missing = draft.productIds.filter((id) => !found.has(id));
    if (missing.length) {
      throw new AdminDiscountError('DISCOUNT_PRODUCT_NOT_FOUND', 'One or more scoped products do not exist', 409, { productIds: missing });
    }
  }
  if (draft.brands.length) {
    const result = await db.prepare(`
      SELECT brand FROM products WHERE trim(brand) <> '' GROUP BY brand COLLATE NOCASE
    `).all();
    const canonical = new Map((result.results || []).map((row) => [String(row.brand).toLowerCase(), row.brand]));
    const missing = draft.brands.filter((brand) => !canonical.has(brand.toLowerCase()));
    if (missing.length) {
      throw new AdminDiscountError('DISCOUNT_BRAND_NOT_FOUND', 'One or more scoped brands do not exist', 409, { brands: missing });
    }
    draft.brands = draft.brands.map((brand) => canonical.get(brand.toLowerCase()));
  }
  return draft;
}

export const changedRows = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

export const catalogScopeMatchSql = (productAlias = 'product') => `(
  ${productAlias}.id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
  OR ${productAlias}.category_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
  OR EXISTS (
    SELECT 1 FROM json_each(?) selected_brand
    WHERE CAST(selected_brand.value AS TEXT) = ${productAlias}.brand COLLATE NOCASE
  )
)`;

export const catalogScopeBindings = (scope) => [
  JSON.stringify(scope.productIds || []),
  JSON.stringify(scope.categoryIds || []),
  JSON.stringify(scope.brands || []),
];
