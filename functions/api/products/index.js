import { apiError, handleApiError, json } from '../../_lib/http.js';
import { imagesByProduct, PRODUCT_IMAGES_SELECT, PRODUCT_SELECT, publicProduct } from '../../_lib/catalog.js';
import { cachedCatalogResponse } from '../../_lib/catalog-cache.js';
import { clampLikeTerm, likeContainsPattern } from '../../_lib/search-pattern.js';

const pageInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

export async function onRequestGet(context) {
  try {
    const request = context.request || new Request('https://nailmania.md/api/products');
    const url = new URL(request.url);
    const limit = pageInteger(url.searchParams.get('limit'), 5000, 1, 5000);
    const offset = pageInteger(url.searchParams.get('offset'), 0, 0, 1_000_000_000);
    const category = String(url.searchParams.get('category') || '').trim().slice(0, 120);
    const brand = String(url.searchParams.get('brand') || '').trim().slice(0, 120);
    const search = clampLikeTerm(url.searchParams.get('q'));
    const stockInput = String(url.searchParams.get('stock') || 'all').trim().toLowerCase().replaceAll('-', '_');
    const sortInput = String(url.searchParams.get('sort') || 'default').trim().toLowerCase().replaceAll('-', '_');
    const stockAliases = {
      all: 'all', in: 'in', available: 'in', in_stock: 'in',
      out: 'out', unavailable: 'out', out_of_stock: 'out',
    };
    const sortOrders = {
      default: 'p.id ASC', catalog: 'p.id ASC',
      price_asc: 'prices.effective_price ASC, p.id ASC',
      price_desc: 'prices.effective_price DESC, p.id ASC',
      name_asc: 'p.name_ro COLLATE NOCASE ASC, p.id ASC',
      name_desc: 'p.name_ro COLLATE NOCASE DESC, p.id ASC',
      newest: 'p.updated_at DESC, p.id DESC',
      featured: 'p.is_featured DESC, p.id ASC',
    };
    const stock = stockAliases[stockInput];
    const orderBy = sortOrders[sortInput];
    if (!stock) return apiError('INVALID_STOCK_FILTER', 'Unknown stock filter', 400);
    if (!orderBy) return apiError('INVALID_PRODUCT_SORT', 'Unknown product sort', 400);

    const conditions = ['p.is_active = 1', 'p.deleted_at IS NULL'];
    const bindings = [];
    if (category) { conditions.push('p.category_id = ?'); bindings.push(category); }
    if (brand) { conditions.push('p.brand = ?'); bindings.push(brand); }
    if (search) {
      conditions.push('(p.name_ro LIKE ? OR p.name_ru LIKE ? OR p.brand LIKE ? OR p.sku LIKE ?)');
      const pattern = likeContainsPattern(search);
      bindings.push(pattern, pattern, pattern, pattern);
    }
    const availableExpression = 'MAX(0, COALESCE(i.on_hand, 0) - COALESCE(i.reserved, 0))';
    if (stock === 'in') conditions.push(`${availableExpression} > 0`);
    if (stock === 'out') conditions.push(`${availableExpression} = 0`);
    const where = ` WHERE ${conditions.join(' AND ')}`;
    return cachedCatalogResponse(context, async ({ db }) => {
      const productsStatement = db.prepare(`${PRODUCT_SELECT}${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
        .bind(...bindings, limit, offset);
      const countStatement = db.prepare(`
        SELECT COUNT(*) AS count
        FROM products p
        LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
        ${where}
      `).bind(...bindings);

      const [productsResult, countRow, imageResult] = await Promise.all([
        productsStatement.all(),
        countStatement.first(),
        db.prepare(PRODUCT_IMAGES_SELECT).all(),
      ]);
      const imageMap = imagesByProduct(imageResult.results);
      const items = (productsResult.results || []).map((row) => publicProduct(row, imageMap.get(row.id) || []));

      return json({
        ok: true,
        items,
        pagination: { limit, offset, total: Number(countRow?.count || 0) },
      });
    }, { fallbackUrl: request.url });
  } catch (error) {
    return handleApiError(error);
  }
}
