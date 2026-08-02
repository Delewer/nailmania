import { requireAdmin } from '../../_lib/admin-auth.js';
import { handleApiError, json } from '../../_lib/http.js';

export async function onRequestGet(context) {
  try {
    const { db } = await requireAdmin(context);
    const [categoryResult, brandResult] = await Promise.all([
      db.prepare(`
        SELECT category.id, category.slug, category.name_ro, category.name_ru,
               COUNT(product.id) AS product_count
        FROM categories category
        LEFT JOIN products product
          ON product.category_id = category.id
         AND product.is_active = 1 AND product.deleted_at IS NULL
        WHERE category.is_active = 1
        GROUP BY category.id
        ORDER BY category.sort_order, category.name_ro, category.id
      `).all(),
      db.prepare(`
        SELECT brand, COUNT(*) AS product_count
        FROM products
        WHERE is_active = 1 AND deleted_at IS NULL AND trim(brand) <> ''
        GROUP BY brand COLLATE NOCASE
        ORDER BY product_count DESC, brand COLLATE NOCASE
      `).all(),
    ]);
    return json({
      ok: true,
      categories: (categoryResult.results || []).map((category) => ({
        id: category.id,
        slug: category.slug,
        nameRo: category.name_ro,
        nameRu: category.name_ru,
        productCount: Number(category.product_count || 0),
      })),
      brands: (brandResult.results || []).map((brand) => ({
        name: brand.brand,
        productCount: Number(brand.product_count || 0),
      })),
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return handleApiError(error);
  }
}
