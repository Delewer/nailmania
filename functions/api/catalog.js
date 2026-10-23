import { PRODUCT_SELECT, publicProduct } from '../_lib/catalog.js';
import { cachedCatalogResponse } from '../_lib/catalog-cache.js';
import { handleApiError, json } from '../_lib/http.js';

export async function onRequestGet(context) {
  try {
    return cachedCatalogResponse(context, async ({ db }) => {
      const [productResult, categoryResult] = await Promise.all([
        db.prepare(`${PRODUCT_SELECT}
          WHERE p.is_active = 1 AND p.deleted_at IS NULL
          ORDER BY p.id ASC
          LIMIT 5000
        `).all(),
        db.prepare(`
          SELECT c.id, c.slug, c.name_ro, c.name_ru, c.sort_order, c.image_url,
                 c.seo_title_ro, c.seo_title_ru, c.seo_description_ro, c.seo_description_ru,
                 COUNT(p.id) AS product_count
          FROM categories c
          LEFT JOIN products p ON p.category_id = c.id AND p.is_active = 1 AND p.deleted_at IS NULL
          WHERE c.is_active = 1
          GROUP BY c.id
          ORDER BY c.sort_order, c.name_ro
        `).all(),
      ]);
      return json({
        ok: true,
        products: (productResult.results || []).map((row) => publicProduct(row)),
        categories: categoryResult.results || [],
      });
    }, { fallbackUrl: 'https://nailmania.md/api/catalog', ignoreSearch: true });
  } catch (error) {
    return handleApiError(error);
  }
}
