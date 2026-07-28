import { cachedCatalogResponse } from './_lib/catalog-cache.js';
import { absoluteUrl, escapeXml, siteOrigin } from './_lib/catalog-seo.js';
import { handleApiError } from './_lib/http.js';

const urlNode = ({ loc, priority, lastmod, image, imageTitle }) => `  <url>
    <loc>${escapeXml(loc)}</loc>${lastmod ? `\n    <lastmod>${escapeXml(String(lastmod).slice(0, 10))}</lastmod>` : ''}
    <priority>${priority}</priority>${image ? `\n    <image:image><image:loc>${escapeXml(image)}</image:loc><image:title>${escapeXml(imageTitle)}</image:title></image:image>` : ''}
  </url>`;

export async function onRequestGet(context) {
  try {
    return cachedCatalogResponse(context, async ({ db }) => {
      const site = siteOrigin(context.env);
      const [categoryResult, productResult] = await Promise.all([
        db.prepare(`
          SELECT c.id, MAX(c.updated_at, COALESCE(MAX(p.updated_at), c.updated_at)) AS lastmod
          FROM categories c
          LEFT JOIN products p ON p.category_id = c.id AND p.is_active = 1 AND p.deleted_at IS NULL
          WHERE c.is_active = 1
          GROUP BY c.id
          ORDER BY c.sort_order, c.id
        `).all(),
        db.prepare(`
          SELECT p.catalog_key, p.name_ro, p.updated_at,
                 (SELECT public_url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order, pi.id LIMIT 1) AS image_url
          FROM products p
          JOIN categories c ON c.id = p.category_id AND c.is_active = 1
          WHERE p.is_active = 1 AND p.deleted_at IS NULL
          ORDER BY p.id
        `).all(),
      ]);
      const urls = [
        { loc: `${site}/`, priority: '1.0' },
        { loc: `${site}/livrare/`, priority: '0.5' },
        { loc: `${site}/plata/`, priority: '0.5' },
        { loc: `${site}/contacte/`, priority: '0.5' },
        ...(categoryResult.results || []).map((category) => ({
          loc: `${site}/category/${encodeURIComponent(category.id)}`,
          priority: '0.8',
          lastmod: category.lastmod,
        })),
        ...(productResult.results || []).map((product) => ({
          loc: `${site}/product/${encodeURIComponent(product.catalog_key)}`,
          priority: '0.6',
          lastmod: product.updated_at,
          image: product.image_url ? absoluteUrl(product.image_url, site) : '',
          imageTitle: product.name_ro,
        })),
      ];
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.map(urlNode).join('\n')}
</urlset>
`;
      return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
    }, { fallbackUrl: 'https://nailmania.md/sitemap.xml', ignoreSearch: true });
  } catch (error) {
    return handleApiError(error);
  }
}
