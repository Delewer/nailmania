import { cachedCatalogResponse } from '../_lib/catalog-cache.js';
import { handleApiError } from '../_lib/http.js';
import {
  absoluteUrl,
  cleanSeoText,
  html,
  loadSpaShell,
  renderSeoHtml,
  siteOrigin,
} from '../_lib/catalog-seo.js';

export async function onRequestGet(context) {
  try {
    const key = decodeURIComponent(String(context.params.key || '')).trim().slice(0, 160);
    return cachedCatalogResponse(context, async ({ db }) => {
      const site = siteOrigin(context.env);
      const shell = await loadSpaShell(context);
      const product = key ? await db.prepare(`
        SELECT
          p.id, p.catalog_key, p.sku, p.slug, p.brand, p.name_ro, p.description_ro,
          prices.effective_price AS price, prices.effective_old_price AS old_price,
          p.updated_at, p.category_id,
          c.name_ro AS category_name,
          MAX(0, COALESCE(i.on_hand, 0) - COALESCE(i.reserved, 0)) AS available_stock
        FROM products p
        JOIN product_catalog_prices prices ON prices.product_id = p.id
        JOIN categories c ON c.id = p.category_id AND c.is_active = 1
        LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
        WHERE p.is_active = 1 AND p.deleted_at IS NULL
          AND (p.catalog_key = ? OR p.slug = ? OR p.sku = ? COLLATE NOCASE)
        LIMIT 1
      `).bind(key, key, key).first() : null;

      if (!product) {
        const canonical = `${site}/product/${encodeURIComponent(key || 'missing')}`;
        return renderSeoHtml(shell, {
          title: 'Produs negăsit | Nail Mania',
          description: 'Produsul solicitat nu este disponibil în catalogul Nail Mania.',
          canonical,
          image: `${site}/images/logo-high.png`,
          robots: 'noindex,follow',
          schema: { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Produs negăsit', url: canonical },
        }, '<h1>Produs negăsit</h1><p>Produsul solicitat nu este disponibil.</p>', 404);
      }

      const imageResult = await db.prepare(`
        SELECT public_url FROM product_images WHERE product_id = ? ORDER BY sort_order, id
      `).bind(product.id).all();
      const images = (imageResult.results || []).map((row) => absoluteUrl(row.public_url, site));
      const image = images[0] || `${site}/images/logo-high.png`;
      const canonical = `${site}/product/${encodeURIComponent(product.catalog_key)}`;
      const description = cleanSeoText(
        product.description_ro || `${product.name_ro} de la ${product.brand}, preț ${product.price} lei. Produs profesional cu livrare în toată Moldova.`,
      );
      const title = cleanSeoText(`${product.name_ro} — ${product.price} lei | Nail Mania`, 70);
      const inStock = Number(product.available_stock || 0) > 0;
      const schema = {
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: product.name_ro,
        description,
        image: images.length ? images : [image],
        sku: product.sku || product.catalog_key,
        category: product.category_name,
        brand: { '@type': 'Brand', name: product.brand },
        offers: {
          '@type': 'Offer',
          url: canonical,
          priceCurrency: 'MDL',
          price: Number(product.price),
          itemCondition: 'https://schema.org/NewCondition',
          availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
          seller: { '@type': 'Organization', name: 'Nail Mania' },
        },
      };
      const body = `<article><p><a href="/category/${encodeURIComponent(product.category_id)}">${html(product.category_name)}</a></p><h1>${html(product.name_ro)}</h1><img src="${html(image)}" alt="${html(product.name_ro)}" width="532" height="492"/><p><strong>${html(product.price)} lei</strong> · ${inStock ? 'În stoc' : 'Stoc epuizat'}</p><p>${html(description)}</p><p>Brand: ${html(product.brand)} · Cod: ${html(product.sku || product.catalog_key)}</p></article>`;
      return renderSeoHtml(shell, { title, description, canonical, image, type: 'product', schema }, body);
    }, { fallbackUrl: `https://nailmania.md/product/${encodeURIComponent(key)}`, ignoreSearch: true });
  } catch (error) {
    return handleApiError(error);
  }
}
