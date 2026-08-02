export class AdminProductError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'AdminProductError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const boolean = (value, fallback = false) => value === undefined ? fallback : Boolean(value);

const integer = (value, field, options = {}) => {
  const { min = 0, max = 10_000_000, nullable = false } = options;
  if (nullable && (value === '' || value === null || value === undefined)) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AdminProductError('INVALID_PRODUCT_FIELD', `${field} must be an integer from ${min} to ${max}`, 400, { field });
  }
  return parsed;
};

const parseSpecs = (value) => {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const normalizeSpecs = (value) => {
  if (!Array.isArray(value)) throw new AdminProductError('INVALID_SPECS', 'Product specifications must be an array');
  if (value.length > 30) throw new AdminProductError('INVALID_SPECS', 'A product can have at most 30 specifications');
  return value.map((entry, index) => {
    const label = text(entry?.label, 120);
    const specificationValue = text(entry?.value, 500);
    if (!label || !specificationValue) {
      throw new AdminProductError('INVALID_SPECS', 'Each specification needs a label and value', 400, { index });
    }
    return { label, value: specificationValue };
  });
};

const objectKeyFromUrl = (url) => {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/api/media/')) return decodeURIComponent(parsed.pathname.slice('/api/media/'.length));
    if (parsed.hostname.endsWith('.r2.dev')) return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {}
  return '';
};

const normalizeImages = (value, names) => {
  if (!Array.isArray(value)) throw new AdminProductError('INVALID_IMAGES', 'Product images must be an array');
  if (value.length > 12) throw new AdminProductError('INVALID_IMAGES', 'A product can have at most 12 images');
  const seen = new Set();
  return value.map((entry, index) => {
    const source = typeof entry === 'string' ? { url: entry } : (entry || {});
    const url = text(source.url, 2048);
    let parsed;
    try { parsed = new URL(url); }
    catch { throw new AdminProductError('INVALID_IMAGE_URL', 'Every image must have a valid URL', 400, { index }); }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new AdminProductError('INVALID_IMAGE_URL', 'Image URLs must use HTTP or HTTPS', 400, { index });
    }
    if (seen.has(url)) throw new AdminProductError('DUPLICATE_IMAGE_URL', 'The same image cannot be added twice', 400, { index });
    seen.add(url);
    const objectKey = text(source.objectKey || objectKeyFromUrl(url), 512);
    if (objectKey && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(objectKey)) {
      throw new AdminProductError('INVALID_IMAGE_KEY', 'Image object key is invalid', 400, { index });
    }
    return {
      url,
      objectKey,
      altRo: text(source.altRo || names.nameRo, 240),
      altRu: text(source.altRu || names.nameRu || names.nameRo, 240),
    };
  });
};

const valueOrCurrent = (input, key, current, fallback) => hasOwn(input, key) ? input[key] : (current?.[key] ?? fallback);

export function normalizeAdminProduct(input, options = {}) {
  const current = options.current || null;
  const creating = !current;
  const sku = text(valueOrCurrent(input, 'sku', current, ''), 80);
  if (!sku || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sku)) {
    throw new AdminProductError('INVALID_SKU', 'SKU is required and may contain only letters, numbers, dots, dashes and underscores');
  }
  const categoryId = text(valueOrCurrent(input, 'categoryId', current, ''), 100);
  const nameRo = text(valueOrCurrent(input, 'nameRo', current, ''), 300);
  const nameRu = text(valueOrCurrent(input, 'nameRu', current, nameRo), 300) || nameRo;
  if (!categoryId) throw new AdminProductError('INVALID_CATEGORY', 'Category is required');
  if (nameRo.length < 2) throw new AdminProductError('INVALID_PRODUCT_NAME', 'Romanian product name is required');

  const price = integer(valueOrCurrent(input, 'price', current, 0), 'price');
  const oldPrice = integer(valueOrCurrent(input, 'oldPrice', current, 0), 'oldPrice');
  if (oldPrice > 0 && oldPrice < price) {
    throw new AdminProductError('INVALID_OLD_PRICE', 'Old price must be zero or greater than or equal to the current price');
  }
  const costPrice = integer(valueOrCurrent(input, 'costPrice', current, null), 'costPrice', { nullable: true });
  const lowStockThreshold = integer(valueOrCurrent(input, 'lowStockThreshold', current, 2), 'lowStockThreshold', { max: 1_000_000 });
  const specs = normalizeSpecs(valueOrCurrent(input, 'specs', current, []));
  const names = { nameRo, nameRu };
  const images = normalizeImages(valueOrCurrent(input, 'images', current, []), names);

  return {
    sku,
    categoryId,
    brand: text(valueOrCurrent(input, 'brand', current, 'Fără brand'), 180) || 'Fără brand',
    nameRo,
    nameRu,
    descriptionRo: text(valueOrCurrent(input, 'descriptionRo', current, ''), 20_000),
    descriptionRu: text(valueOrCurrent(input, 'descriptionRu', current, ''), 20_000),
    price,
    oldPrice,
    costPrice,
    specs,
    images,
    isActive: boolean(valueOrCurrent(input, 'isActive', current, true), true),
    isFeatured: boolean(valueOrCurrent(input, 'isFeatured', current, false)),
    isNew: boolean(valueOrCurrent(input, 'isNew', current, false)),
    isPromo: boolean(valueOrCurrent(input, 'isPromo', current, false)),
    isSummer: boolean(valueOrCurrent(input, 'isSummer', current, false)),
    lowStockThreshold,
    initialStock: creating ? integer(input?.initialStock ?? 0, 'initialStock', { max: 1_000_000 }) : undefined,
    catalogKey: creating ? sku : current.key,
    slug: creating ? sku.toLowerCase() : current.slug,
  };
}

const number = (value) => Number(value || 0);

export const ADMIN_PRODUCT_SELECT = `
  SELECT p.*, c.name_ro AS category_name_ro, c.name_ru AS category_name_ru,
         COALESCE(i.on_hand, 0) AS on_hand, COALESCE(i.reserved, 0) AS reserved,
         i.admin_revision AS inventory_revision,
         prices.effective_price, prices.effective_old_price,
         prices.discount_percentage, prices.effective_is_promo,
         (SELECT pi.public_url FROM product_images pi
          WHERE pi.product_id = p.id ORDER BY pi.sort_order, pi.id LIMIT 1) AS primary_image,
         (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id) AS image_count
  FROM products p
  JOIN categories c ON c.id = p.category_id
  JOIN product_catalog_prices prices ON prices.product_id = p.id
  LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
`;

export function adminProductSummary(row) {
  const onHand = number(row.on_hand);
  const reserved = number(row.reserved);
  return {
    id: row.id,
    key: row.catalog_key,
    sku: row.sku,
    categoryId: row.category_id,
    categoryName: row.category_name_ro,
    brand: row.brand,
    name: row.name_ro,
    price: number(row.price),
    oldPrice: number(row.old_price),
    effectivePrice: number(row.effective_price),
    effectiveOldPrice: number(row.effective_old_price),
    discountPercentage: number(row.discount_percentage),
    isActive: Boolean(row.is_active) && !row.deleted_at,
    isDeleted: Boolean(row.deleted_at),
    isNew: Boolean(row.is_new),
    isPromo: Boolean(row.is_promo),
    effectiveIsPromo: Boolean(row.effective_is_promo),
    onHand,
    reserved,
    available: Math.max(0, onHand - reserved),
    lowStockThreshold: number(row.low_stock_threshold),
    image: row.primary_image || '',
    imageCount: number(row.image_count),
    sourceType: row.source_type || 'import',
    updatedAt: row.updated_at,
    revision: row.admin_revision || '',
  };
}

export async function getAdminProduct(db, id) {
  const key = text(id, 120);
  const row = await db.prepare(`${ADMIN_PRODUCT_SELECT}
    WHERE CAST(p.id AS TEXT) = ? OR p.catalog_key = ?
    LIMIT 1
  `).bind(key, key).first();
  if (!row) return null;
  const [imageResult, movementResult] = await Promise.all([
    db.prepare(`
      SELECT id, object_key, public_url, alt_ro, alt_ru, sort_order, is_primary
      FROM product_images WHERE product_id = ? ORDER BY sort_order, id
    `).bind(row.id).all(),
    db.prepare(`
      SELECT m.id, m.movement_type, m.delta_on_hand, m.delta_reserved,
             m.balance_on_hand, m.balance_reserved, m.reason, m.created_at,
             u.id AS actor_id, u.name AS actor_name, u.email AS actor_email
      FROM inventory_movements m
      LEFT JOIN users u ON u.id = m.actor_user_id
      WHERE m.product_id = ? AND m.warehouse_id = 1
      ORDER BY m.created_at DESC, m.id DESC LIMIT 100
    `).bind(row.id).all(),
  ]);
  const summary = adminProductSummary(row);
  return {
    ...summary,
    slug: row.slug,
    nameRo: row.name_ro,
    nameRu: row.name_ru,
    descriptionRo: row.description_ro,
    descriptionRu: row.description_ru,
    costPrice: row.cost_price === null ? null : number(row.cost_price),
    specs: parseSpecs(row.specs_json),
    isFeatured: Boolean(row.is_featured),
    isSummer: Boolean(row.is_summer),
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    inventoryRevision: row.inventory_revision || '',
    images: (imageResult.results || []).map((image) => ({
      id: image.id,
      objectKey: image.object_key,
      url: image.public_url,
      altRo: image.alt_ro,
      altRu: image.alt_ru,
      sortOrder: number(image.sort_order),
      isPrimary: Boolean(image.is_primary),
    })),
    movements: (movementResult.results || []).map((movement) => ({
      id: movement.id,
      type: movement.movement_type,
      deltaOnHand: number(movement.delta_on_hand),
      deltaReserved: number(movement.delta_reserved),
      balanceOnHand: number(movement.balance_on_hand),
      balanceReserved: number(movement.balance_reserved),
      reason: movement.reason,
      createdAt: movement.created_at,
      actor: movement.actor_id ? {
        id: movement.actor_id,
        name: movement.actor_name,
        email: movement.actor_email,
      } : null,
    })),
  };
}

export function productSnapshot(product) {
  return {
    id: product.id,
    key: product.key,
    sku: product.sku,
    categoryId: product.categoryId,
    brand: product.brand,
    nameRo: product.nameRo,
    nameRu: product.nameRu,
    price: product.price,
    oldPrice: product.oldPrice,
    costPrice: product.costPrice,
    isActive: product.isActive,
    isFeatured: product.isFeatured,
    isNew: product.isNew,
    isPromo: product.isPromo,
    isSummer: product.isSummer,
    lowStockThreshold: product.lowStockThreshold,
    onHand: product.onHand,
    reserved: product.reserved,
    images: (product.images || []).map((image) => image.url),
  };
}

export function stockAdjustmentPlan(input, inventory) {
  const operation = text(input?.operation, 30);
  const reason = text(input?.reason, 500);
  if (!['receipt', 'write_off', 'adjustment', 'return'].includes(operation)) {
    throw new AdminProductError('INVALID_STOCK_OPERATION', 'Unknown stock operation');
  }
  if (reason.length < 3) throw new AdminProductError('STOCK_REASON_REQUIRED', 'A reason of at least 3 characters is required');
  const currentOnHand = number(inventory?.onHand);
  const reserved = number(inventory?.reserved);
  let nextOnHand;
  if (operation === 'adjustment') {
    nextOnHand = integer(input?.targetOnHand, 'targetOnHand', { max: 1_000_000 });
  } else {
    const quantity = integer(input?.quantity, 'quantity', { min: 1, max: 1_000_000 });
    nextOnHand = currentOnHand + (operation === 'write_off' ? -quantity : quantity);
  }
  if (nextOnHand < reserved) {
    throw new AdminProductError(
      'INSUFFICIENT_UNRESERVED_STOCK',
      'Stock cannot be reduced below the reserved quantity',
      409,
      { onHand: currentOnHand, reserved, requestedOnHand: nextOnHand },
    );
  }
  if (nextOnHand === currentOnHand) throw new AdminProductError('STOCK_UNCHANGED', 'The stock value is unchanged');
  return {
    operation,
    reason,
    deltaOnHand: nextOnHand - currentOnHand,
    nextOnHand,
    currentOnHand,
    reserved,
  };
}

export const changedRows = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);
