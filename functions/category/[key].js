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
    const key = decodeURIComponent(String(context.params.key || '')).trim().slice(0, 160);
    return cachedCatalogResponse(context, async ({ db }) => {
      const site = siteOrigin(context.env);
      const shell = await loadSpaShell(context);
      const category = key ? await db.prepare(`
        SELECT id, slug, name_ro, seo_title_ro, seo_description_ro, updated_at
        FROM categories
        WHERE is_active = 1 AND (id = ? OR slug = ?)
        LIMIT 1
      `).bind(key, key).first() : null;

      if (!category) {
        const canonical = `${site}/category/${encodeURIComponent(key || 'missing')}`;
        return renderSeoHtml(shell, {
          title: 'Categorie negăsită | Nail Mania',
          description: 'Categoria solicitată nu este disponibilă în catalogul Nail Mania.',
          canonical,
          image: `${site}/images/logo-high.png`,
          robots: 'noindex,follow',
          schema: { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Categorie negăsită', url: canonical },
        }, '<h1>Categorie negăsită</h1><p>Categoria solicitată nu este disponibilă.</p>', 404);
      }

      const productsResult = await db.prepare(`
        SELECT catalog_key, name_ro
        FROM products
        WHERE category_id = ? AND is_active = 1 AND deleted_at IS NULL
        ORDER BY is_featured DESC, updated_at DESC, id DESC
        LIMIT 24
      `).bind(category.id).all();
      const canonical = `${site}/category/${encodeURIComponent(category.id)}`;
      const title = cleanSeoText(category.seo_title_ro || `${category.name_ro} — produse profesionale | Nail Mania`, 70);
      const description = cleanSeoText(
        category.seo_description_ro || `Cumpără ${category.name_ro.toLowerCase()} și produse profesionale pentru salon de la Nail Mania, cu livrare în toată Moldova.`,
      );
      const links = (productsResult.results || []).map((product) => (
        `<li><a href="/product/${encodeURIComponent(product.catalog_key)}">${html(product.name_ro)}</a></li>`
      )).join('');
      const schema = {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: category.name_ro,
        description,
        url: canonical,
        mainEntity: {
          '@type': 'ItemList',
          itemListElement: (productsResult.results || []).map((product, index) => ({
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
      }, `<h1>${html(category.name_ro)}</h1><p>${html(description)}</p><ul>${links}</ul>`);
    }, { fallbackUrl: `https://nailmania.md/category/${encodeURIComponent(key)}`, ignoreSearch: true });
  } catch (error) {
    return handleApiError(error);
  }
}
