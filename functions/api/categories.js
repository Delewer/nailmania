import { handleApiError, json } from '../_lib/http.js';
import { cachedCatalogResponse } from '../_lib/catalog-cache.js';

export async function onRequestGet(context) {
  try {
    return cachedCatalogResponse(context, async ({ db }) => {
      const result = await db.prepare(`
        SELECT c.id, c.slug, c.name_ro, c.name_ru, c.sort_order,
               c.seo_title_ro, c.seo_title_ru, c.seo_description_ro, c.seo_description_ru,
               COUNT(p.id) AS product_count
        FROM categories c
        LEFT JOIN products p ON p.category_id = c.id AND p.is_active = 1 AND p.deleted_at IS NULL
        WHERE c.is_active = 1
        GROUP BY c.id
        ORDER BY c.sort_order, c.name_ro
      `).all();
      return json({ ok: true, items: result.results || [] });
    }, { fallbackUrl: 'https://nailmania.md/api/categories' });
  } catch (error) {
    return handleApiError(error);
  }
}
