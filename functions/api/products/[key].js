import { handleApiError, apiError, json } from '../../_lib/http.js';
import { PRODUCT_SELECT, publicProduct } from '../../_lib/catalog.js';
import { cachedCatalogResponse } from '../../_lib/catalog-cache.js';

export async function onRequestGet(context) {
  try {
    const key = decodeURIComponent(String(context.params.key || '')).trim();
    if (!key) return apiError('INVALID_PRODUCT_KEY', 'Product key is required', 400);

    return cachedCatalogResponse(context, async ({ db }) => {
      let row = await db.prepare(`${PRODUCT_SELECT}
        WHERE p.is_active = 1 AND p.deleted_at IS NULL
          AND p.catalog_key = ?
        LIMIT 1`).bind(key).first();
      // Slug/SKU lookup remains a compatibility fallback; canonical storefront
      // links always use catalog_key and therefore take the indexed fast path.
      if (!row) row = await db.prepare(`${PRODUCT_SELECT}
        WHERE p.is_active = 1 AND p.deleted_at IS NULL
          AND (p.slug = ? OR p.sku = ? COLLATE NOCASE)
        LIMIT 1`).bind(key, key).first();
      if (!row) return apiError('PRODUCT_NOT_FOUND', 'Product not found', 404);
      return json({ ok: true, item: publicProduct(row) });
    }, { fallbackUrl: `https://nailmania.md/api/products/${encodeURIComponent(key)}` });
  } catch (error) {
    return handleApiError(error);
  }
}
