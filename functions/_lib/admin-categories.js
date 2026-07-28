export class AdminCategoryError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'AdminCategoryError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const text = (value, max = 300) => String(value ?? '').trim().slice(0, max);
const boolean = (value, fallback) => value === undefined ? fallback : Boolean(value);

export const slugifyCategory = (value) => text(value, 180)
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80)
  .replace(/-+$/g, '');

const integer = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
};

export function normalizeAdminCategory(input, options = {}) {
  const current = options.current || null;
  const body = input && typeof input === 'object' ? input : {};
  const nameRo = text(body.nameRo ?? current?.nameRo, 180);
  if (!nameRo) throw new AdminCategoryError('INVALID_CATEGORY_NAME', 'Romanian category name is required');

  const requestedSlug = current?.slug || slugifyCategory(body.slug || nameRo);
  if (!requestedSlug || requestedSlug.length < 2) {
    throw new AdminCategoryError('INVALID_CATEGORY_SLUG', 'Category URL key must contain at least two Latin letters or digits');
  }
  const sortOrder = integer(body.sortOrder, current?.sortOrder ?? options.defaultSortOrder ?? 0);
  if (sortOrder < 0 || sortOrder > 9999) {
    throw new AdminCategoryError('INVALID_CATEGORY_SORT', 'Category sort order must be between 0 and 9999');
  }

  return {
    id: current?.id || requestedSlug,
    slug: requestedSlug,
    nameRo,
    nameRu: text(body.nameRu ?? current?.nameRu, 180),
    sortOrder,
    isActive: boolean(body.isActive, current?.isActive ?? true),
    seoTitleRo: text(body.seoTitleRo ?? current?.seoTitleRo, 300),
    seoTitleRu: text(body.seoTitleRu ?? current?.seoTitleRu, 300),
    seoDescriptionRo: text(body.seoDescriptionRo ?? current?.seoDescriptionRo, 1000),
    seoDescriptionRu: text(body.seoDescriptionRu ?? current?.seoDescriptionRu, 1000),
  };
}

export const ADMIN_CATEGORY_SELECT = `
  SELECT
    c.id, c.slug, c.name_ro, c.name_ru, c.sort_order, c.is_active,
    c.seo_title_ro, c.seo_title_ru, c.seo_description_ro, c.seo_description_ru,
    c.source_type, COALESCE(c.admin_revision, '') AS admin_revision,
    c.created_at, c.updated_at,
    COUNT(p.id) AS product_count,
    SUM(CASE WHEN p.is_active = 1 AND p.deleted_at IS NULL THEN 1 ELSE 0 END) AS active_product_count
  FROM categories c
  LEFT JOIN products p ON p.category_id = c.id
`;

export function adminCategory(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    nameRo: row.name_ro,
    nameRu: row.name_ru,
    sortOrder: Number(row.sort_order || 0),
    isActive: Boolean(row.is_active),
    seoTitleRo: row.seo_title_ro,
    seoTitleRu: row.seo_title_ru,
    seoDescriptionRo: row.seo_description_ro,
    seoDescriptionRu: row.seo_description_ru,
    sourceType: row.source_type || 'import',
    revision: row.admin_revision || '',
    productCount: Number(row.product_count || 0),
    activeProductCount: Number(row.active_product_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getAdminCategory(db, id) {
  const row = await db.prepare(`${ADMIN_CATEGORY_SELECT}
    WHERE c.id = ? COLLATE NOCASE OR c.slug = ? COLLATE NOCASE
    GROUP BY c.id
    LIMIT 1
  `).bind(id, id).first();
  return adminCategory(row);
}

export const categorySnapshot = (category) => ({
  id: category.id,
  slug: category.slug,
  nameRo: category.nameRo,
  nameRu: category.nameRu,
  sortOrder: category.sortOrder,
  isActive: category.isActive,
  seoTitleRo: category.seoTitleRo,
  seoTitleRu: category.seoTitleRu,
  seoDescriptionRo: category.seoDescriptionRo,
  seoDescriptionRu: category.seoDescriptionRu,
  productCount: category.productCount,
});

export const changedRows = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);
