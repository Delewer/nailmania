import { cachedCatalogResponse } from '../../../_lib/catalog-cache.js';
import { apiError, handleApiError, json } from '../../../_lib/http.js';

export async function onRequestGet(context) {
  try {
    const id = decodeURIComponent(String(context.params.id || '')).trim().slice(0, 160);
    if (!id) return apiError('INVALID_PRODUCT_ID', 'Product id is required', 400);
    return cachedCatalogResponse(context, async ({ db }) => {
      const product = await db.prepare(`
        SELECT
          p.id, p.catalog_key,
          MAX(0, COALESCE(i.on_hand, 0) - COALESCE(i.reserved, 0)) AS available,
          i.updated_at
        FROM products p
        JOIN categories c ON c.id = p.category_id AND c.is_active = 1
        LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
        WHERE p.is_active = 1 AND p.deleted_at IS NULL
          AND (CAST(p.id AS TEXT) = ? OR p.catalog_key = ? OR p.slug = ? OR p.sku = ? COLLATE NOCASE)
        LIMIT 1
      `).bind(id, id, id, id).first();
      if (!product) return apiError('PRODUCT_NOT_FOUND', 'Product not found', 404);
      const available = Math.max(0, Number(product.available || 0));
      return json({
        ok: true,
        availability: {
          productId: Number(product.id),
          productKey: product.catalog_key,
          available,
          inStock: available > 0,
          updatedAt: product.updated_at || null,
        },
      });
    }, { fallbackUrl: `https://nailmania.md/api/products/${encodeURIComponent(id)}/availability`, ignoreSearch: true });
  } catch (error) {
    return handleApiError(error);
  }
}
