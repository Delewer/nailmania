const parseSpecs = (value) => {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const catalogImageUrls = (value) => {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string' && item) : [];
  } catch {
    return [];
  }
};

export const publicProduct = (row, images = catalogImageUrls(row.images_json)) => ({
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
    MAX(0, COALESCE(i.on_hand, 0) - COALESCE(i.reserved, 0) + COALESCE((
      SELECT SUM(r.quantity) FROM cart_reservations r
      WHERE r.product_id = p.id AND r.status = 'ACTIVE'
        AND r.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ), 0)) AS available_stock,
    COALESCE((
      SELECT json_group_array(ordered.public_url)
      FROM (
        SELECT pi.public_url
        FROM product_images pi
        WHERE pi.product_id = p.id
        ORDER BY pi.sort_order, pi.id
      ) ordered
    ), '[]') AS images_json
  FROM products p
  JOIN product_catalog_prices prices ON prices.product_id = p.id
  LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
`;
