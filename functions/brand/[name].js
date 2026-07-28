import { cachedCatalogResponse } from '../_lib/catalog-cache.js';
import { handleApiError } from '../_lib/http.js';
import {
  cleanSeoText,
  html,
  loadSpaShell,
  renderSeoHtml,
  siteOrigin,
} from '../_lib/catalog-seo.js';

export async function onRequestGet(context) {
  try {
    const requestedBrand = decodeURIComponent(String(context.params.name || '')).trim().slice(0, 180);
    return cachedCatalogResponse(context, async ({ db }) => {
      const site = siteOrigin(context.env);
      const shell = await loadSpaShell(context);
      const productsResult = requestedBrand ? await db.prepare(`
        SELECT catalog_key, brand, name_ro
        FROM products
        WHERE brand = ? AND is_active = 1 AND deleted_at IS NULL
        ORDER BY is_featured DESC, updated_at DESC, id DESC
        LIMIT 24
      `).bind(requestedBrand).all() : { results: [] };
      const products = productsResult.results || [];

      if (!products.length) {
        const canonical = `${site}/brand/${encodeURIComponent(requestedBrand || 'missing')}`;
        return renderSeoHtml(shell, {
          title: 'Brand negăsit | Nail Mania',
          description: 'Brandul solicitat nu este disponibil în catalogul Nail Mania.',
          canonical,
          image: `${site}/images/logo-high.png`,
          robots: 'noindex,follow',
          schema: { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Brand negăsit', url: canonical },
        }, '<h1>Brand negăsit</h1><p>Brandul solicitat nu este disponibil.</p>', 404);
      }

      const brand = products[0].brand;
      const canonical = `${site}/brand/${encodeURIComponent(brand)}`;
      const title = cleanSeoText(`${brand} — produse profesionale | Nail Mania`, 70);
      const description = cleanSeoText(
        `Produse profesionale ${brand} pentru manichiură și salon, cu prețuri actuale și livrare în toată Moldova.`,
      );
      const links = products.map((product) => (
        `<li><a href="/product/${encodeURIComponent(product.catalog_key)}">${html(product.name_ro)}</a></li>`
      )).join('');
      const schema = {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: `Produse ${brand}`,
        description,
        url: canonical,
        mainEntity: {
          '@type': 'ItemList',
          itemListElement: products.map((product, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            url: `${site}/product/${encodeURIComponent(product.catalog_key)}`,
            name: product.name_ro,
          })),
        },
      };
      return renderSeoHtml(shell, {
        title,
        description,
        canonical,
        image: `${site}/images/logo-high.png`,
        schema,
      }, `<h1>${html(brand)}</h1><p>${html(description)}</p><ul>${links}</ul>`);
    }, { fallbackUrl: `https://nailmania.md/brand/${encodeURIComponent(requestedBrand)}`, ignoreSearch: true });
  } catch (error) {
    return handleApiError(error);
  }
}
