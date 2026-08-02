const parseSpecs = (value) => {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const imagesByProduct = (rows) => {
  const grouped = new Map();
  for (const row of rows || []) {
    const list = grouped.get(row.product_id) || [];
    list.push(row.public_url);
    grouped.set(row.product_id, list);
  }
  return grouped;
};

export const publicProduct = (row, images = []) => ({
  id: row.id,
  key: row.catalog_key,
  code: row.sku || '',
  cat: row.category_id,
  brand: row.brand,
  name: row.name_ro,
  nameRu: row.name_ru || row.name_ro,
  price: row.price,
  old: row.old_price || 0,
  desc: row.description_ro || '',
  stock: Math.max(0, Number(row.available_stock || 0)),
  ...(images.length ? { image: images.join(' ') } : {}),
  ...(parseSpecs(row.specs_json).length ? { specs: parseSpecs(row.specs_json) } : {}),
  ...(row.is_new ? { isNew: true } : {}),
  ...(row.is_promo ? { promo: true } : {}),
  ...(row.is_summer ? { summer: true } : {}),
});

export const PRODUCT_SELECT = `
  SELECT
    p.id, p.catalog_key, p.sku, p.category_id, p.brand, p.name_ro, p.name_ru,
    p.description_ro, prices.effective_price AS price,
    prices.effective_old_price AS old_price, p.specs_json,
    p.is_new, prices.effective_is_promo AS is_promo, p.is_summer,
    MAX(0, COALESCE(i.on_hand, 0) - COALESCE(i.reserved, 0)) AS available_stock
  FROM products p
  JOIN product_catalog_prices prices ON prices.product_id = p.id
  LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
`;

export const PRODUCT_IMAGES_SELECT = `
  SELECT pi.product_id, pi.public_url
  FROM product_images pi
  JOIN products p ON p.id = pi.product_id
  WHERE p.is_active = 1 AND p.deleted_at IS NULL
  ORDER BY pi.product_id, pi.sort_order, pi.id
`;
