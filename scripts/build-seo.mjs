/* Build only catalog-independent HTML. Product/category/brand HTML and sitemap are D1 Pages Functions. */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const SITE = 'https://nailmania.md';
const DEFAULT_IMAGE = `${SITE}/images/logo-high.png`;
const baseHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const clean = (value, max = 160) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const routePath = (route) => route === '/' ? '/' : route.replace(/\/?$/, '/');
const routeUrl = (route) => SITE + routePath(route);

function seoHead({
  title,
  description,
  canonical,
  image = DEFAULT_IMAGE,
  type = 'website',
  robots = 'index,follow,max-image-preview:large',
  schema = {},
}) {
  return `<!-- SEO:START -->
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}"/>
<meta name="robots" content="${escapeHtml(robots)}"/>
<link rel="canonical" href="${escapeHtml(canonical)}"/>
<meta property="og:type" content="${escapeHtml(type)}"/>
<meta property="og:site_name" content="Nail Mania"/>
<meta property="og:locale" content="ro_MD"/>
<meta property="og:title" content="${escapeHtml(title)}"/>
<meta property="og:description" content="${escapeHtml(description)}"/>
<meta property="og:url" content="${escapeHtml(canonical)}"/>
<meta property="og:image" content="${escapeHtml(image)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escapeHtml(title)}"/>
<meta name="twitter:description" content="${escapeHtml(description)}"/>
<meta name="twitter:image" content="${escapeHtml(image)}"/>
<script id="seo-jsonld" type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>
<!-- SEO:END -->`;
}

function shell(meta, body) {
  return baseHtml
    .replace(/<!-- SEO:START -->[\s\S]*?<!-- SEO:END -->/, seoHead(meta))
    .replace(
      '<div id="root"></div>',
      `<div id="root"><main class="seo-static" style="max-width:1180px;margin:40px auto;padding:20px;font-family:Arial,sans-serif;color:#2d212a">${body}</main></div>`,
    );
}

function writeRoute(route, meta, body) {
  const relative = route.replace(/^\//, '');
  const rendered = shell(meta, body);
  const htmlFile = path.join(DIST, `${relative}.html`);
  fs.mkdirSync(path.dirname(htmlFile), { recursive: true });
  fs.writeFileSync(htmlFile, rendered);
  const indexFile = path.join(DIST, relative, 'index.html');
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(indexFile, rendered);
}

// Pages Functions fetch this exact Vite shell through env.ASSETS before injecting D1 SEO.
// It intentionally retains an empty #root so React can mount normally.
fs.writeFileSync(path.join(DIST, 'spa-shell.html'), baseHtml);

const homeTitle = 'Nail Mania Moldova — produse profesionale pentru manichiură';
const homeDescription = 'Magazin online cu produse profesionale pentru manichiură, pedichiură și epilare, cu livrare în toată Moldova.';
const storeSchema = {
  '@context': 'https://schema.org',
  '@type': 'Store',
  '@id': `${SITE}/#store`,
  name: 'Nail Mania',
  url: `${SITE}/`,
  logo: DEFAULT_IMAGE,
  image: DEFAULT_IMAGE,
  telephone: '+37368067486',
  priceRange: '$$',
  currenciesAccepted: 'MDL',
  address: {
    '@type': 'PostalAddress',
    streetAddress: 'str. Romană 66/2',
    addressLocality: 'Ungheni',
    addressCountry: 'MD',
  },
  sameAs: ['https://www.instagram.com/nailmania_md'],
};
fs.writeFileSync(path.join(DIST, 'index.html'), shell({
  title: homeTitle,
  description: homeDescription,
  canonical: `${SITE}/`,
  schema: storeSchema,
}, `<h1>Produse profesionale pentru manichiură și pedichiură</h1><p>${escapeHtml(homeDescription)}</p><p><a href="/search">Vezi catalogul Nail Mania</a></p>`));

const contentPages = [
  ['/livrare', 'Livrare în Moldova | Nail Mania', 'Condiții și termene de livrare pentru comenzile Nail Mania în Ungheni, Chișinău și toată Moldova.'],
  ['/plata', 'Metode de plată | Nail Mania', 'Metode de plată disponibile pentru comenzile Nail Mania: numerar, card bancar și plată la livrare.'],
  ['/contacte', 'Contacte Nail Mania Ungheni', 'Magazin Nail Mania: str. Romană 66/2, Ungheni, Moldova. Telefon +373 68 067 486.'],
];
for (const [route, title, description] of contentPages) {
  writeRoute(route, {
    title: clean(title, 70),
    description: clean(description),
    canonical: routeUrl(route),
    schema: { '@context': 'https://schema.org', '@type': 'WebPage', name: title, description, url: routeUrl(route) },
  }, `<h1>${escapeHtml(title.replace(' | Nail Mania', ''))}</h1><p>${escapeHtml(description)}</p>`);
}

writeRoute('/checkout', {
  title: 'Finalizarea comenzii | Nail Mania',
  description: 'Finalizarea comenzii Nail Mania.',
  canonical: routeUrl('/checkout'),
  robots: 'noindex,nofollow',
}, '<h1>Finalizarea comenzii</h1>');
writeRoute('/search', {
  title: 'Căutare produse | Nail Mania',
  description: 'Căutare produse Nail Mania.',
  canonical: routeUrl('/search'),
  robots: 'noindex,follow',
}, '<h1>Căutare produse</h1>');

console.log('SEO: catalog-independent home/content shells built; product/category/brand/sitemap are served from D1');
