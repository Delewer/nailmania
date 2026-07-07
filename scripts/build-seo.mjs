/* Generate crawlable route HTML, sitemap.xml, and structured data after Vite. */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const SITE = 'https://nailmania.md';
const DEFAULT_IMAGE = SITE + '/images/logo-high.png';
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'catalog.json'), 'utf8'));
const categories = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'categories.json'), 'utf8'));
const baseHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const escapeXml = escapeHtml;
const clean = (value, max = 160) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const routeUrl = (route) => SITE + (route === '/' ? '/' : route);
const firstImage = (product) => {
  const image = String(product.image || '').split(/[\s,]+/).find(Boolean);
  if (!image) return DEFAULT_IMAGE;
  return /^https?:\/\//.test(image) ? image : SITE + '/' + image.replace(/^\//, '');
};
const available = (product) => typeof product.stock !== 'number' || product.stock > 0;
const categoryById = new Map(categories.map((category) => [category.id, category]));
const productTitleKeys = new Map();
for (const product of catalog) {
  const key = `${product.name}|${product.price}`;
  productTitleKeys.set(key, (productTitleKeys.get(key) || 0) + 1);
}
const productTitle = (product) => {
  const suffix = ` — ${product.price} lei | Nail Mania`;
  const duplicate = productTitleKeys.get(`${product.name}|${product.price}`) > 1;
  const identifier = duplicate ? ` (${product.code || product.key})` : '';
  const availableNameLength = Math.max(20, 70 - suffix.length - identifier.length);
  return clean(product.name, availableNameLength) + identifier + suffix;
};

function seoHead({ title, description, canonical, image = DEFAULT_IMAGE, type = 'website', robots = 'index,follow,max-image-preview:large', schema }) {
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
<script id="seo-jsonld" type="application/ld+json">${JSON.stringify(schema || {}).replace(/</g, '\\u003c')}</script>
<!-- SEO:END -->`;
}

function shell(meta, body) {
  return baseHtml
    .replace(/<!-- SEO:START -->[\s\S]*?<!-- SEO:END -->/, seoHead(meta))
    .replace('<div id="root"></div>', `<div id="root"><main class="seo-static" style="max-width:1180px;margin:40px auto;padding:20px;font-family:Arial,sans-serif;color:#2d212a">${body}</main></div>`);
}

function writeRoute(route, meta, body) {
  const relative = route.replace(/^\//, '');
  const file = path.join(DIST, relative + '.html');
  fs.mkdirSync(path.dirname(file), { recursive:true });
  fs.writeFileSync(file, shell(meta, body));
}

const urls = [{ loc:SITE+'/', priority:'1.0' }];

for (const category of categories) {
  const route = '/category/' + encodeURIComponent(category.id);
  const title = clean(`${category.label} — produse profesionale | Nail Mania`, 70);
  const description = clean(`Cumpără ${category.label.toLowerCase()} și produse profesionale pentru salon de la Nail Mania. Livrare rapidă în Ungheni, Chișinău și toată Moldova.`);
  const products = catalog.filter((product) => product.cat === category.id).slice(0, 24);
  const links = products.map((product) => `<li><a href="/product/${encodeURIComponent(product.key)}">${escapeHtml(product.name)}</a></li>`).join('');
  writeRoute(route, { title, description, canonical:routeUrl(route), schema:{ '@context':'https://schema.org', '@type':'CollectionPage', name:category.label, description, url:routeUrl(route) } }, `<h1>${escapeHtml(category.label)}</h1><p>${escapeHtml(description)}</p><ul>${links}</ul>`);
  urls.push({ loc:routeUrl(route), priority:'0.8' });
}

const brands = [...new Set(catalog.map((product) => product.brand).filter((brand) => brand && !/^f.r. brand$/i.test(brand)))].sort();
for (const brand of brands) {
  const route = '/brand/' + encodeURIComponent(brand);
  const title = clean(`${brand} — produse profesionale | Nail Mania`, 70);
  const description = clean(`Produse profesionale ${brand} pentru manichiură și salon. Prețuri actuale, stoc și livrare în toată Moldova de la Nail Mania.`);
  const links = catalog.filter((product) => product.brand === brand).slice(0, 24).map((product) => `<li><a href="/product/${encodeURIComponent(product.key)}">${escapeHtml(product.name)}</a></li>`).join('');
  writeRoute(route, { title, description, canonical:routeUrl(route), schema:{ '@context':'https://schema.org', '@type':'CollectionPage', name:`Produse ${brand}`, description, url:routeUrl(route) } }, `<h1>${escapeHtml(brand)}</h1><p>${escapeHtml(description)}</p><ul>${links}</ul>`);
  urls.push({ loc:routeUrl(route), priority:'0.7' });
}

for (const product of catalog) {
  const route = '/product/' + encodeURIComponent(product.key);
  const canonical = routeUrl(route);
  const category = categoryById.get(product.cat)?.label || product.cat;
  const description = clean(`${product.name} de la ${product.brand}, preț ${product.price} lei. ${product.desc || `Produs profesional din categoria ${category}, cu livrare în toată Moldova.`}`);
  const image = firstImage(product);
  const title = productTitle(product);
  const schema = {
    '@context':'https://schema.org', '@type':'Product', name:product.name, description, image:[image], sku:product.code || product.key,
    category, brand:{ '@type':'Brand', name:product.brand },
    offers:{ '@type':'Offer', url:canonical, priceCurrency:'MDL', price:product.price, itemCondition:'https://schema.org/NewCondition', availability:available(product)?'https://schema.org/InStock':'https://schema.org/OutOfStock', seller:{ '@type':'Organization', name:'Nail Mania' } },
  };
  const stock = available(product) ? 'În stoc' : 'Stoc epuizat';
  writeRoute(route, { title, description, canonical, image, type:'product', schema }, `<article><p><a href="/category/${encodeURIComponent(product.cat)}">${escapeHtml(category)}</a></p><h1>${escapeHtml(product.name)}</h1><img src="${escapeHtml(image)}" alt="${escapeHtml(product.name)}" width="532" height="492"/><p><strong>${escapeHtml(product.price)} lei</strong> · ${stock}</p><p>${escapeHtml(description)}</p><p>Brand: ${escapeHtml(product.brand)} · Cod: ${escapeHtml(product.code || product.key)}</p></article>`);
  urls.push({ loc:canonical, priority:'0.6', image, imageTitle:product.name });
}

const contentPages = [
  ['/livrare','Livrare în Moldova | Nail Mania','Condiții și termene de livrare pentru comenzile Nail Mania în Ungheni, Chișinău, toată Moldova și Europa.'],
  ['/plata','Metode de plată | Nail Mania','Metode de plată disponibile pentru comenzile Nail Mania: numerar, card bancar, transfer și plată la livrare.'],
  ['/contacte','Contacte Nail Mania Ungheni','Magazin Nail Mania: str. Romană 66/2, Ungheni, Moldova. Telefon +373 68 067 486. Comenzi online 24/7.'],
];
for (const [route, title, description] of contentPages) {
  writeRoute(route, { title, description, canonical:routeUrl(route), schema:{ '@context':'https://schema.org', '@type':'WebPage', name:title, description, url:routeUrl(route) } }, `<h1>${escapeHtml(title.replace(' | Nail Mania',''))}</h1><p>${escapeHtml(description)}</p>`);
  urls.push({ loc:routeUrl(route), priority:'0.5' });
}

const homeTitle = 'Nail Mania Moldova — produse profesionale pentru manichiură';
const homeDescription = 'Magazin online cu produse profesionale pentru manichiură, pedichiură și epilare. Peste 1800 de produse, livrare în toată Moldova și magazin în Ungheni.';
const storeSchema = { '@context':'https://schema.org', '@type':'Store', '@id':SITE+'/#store', name:'Nail Mania', url:SITE+'/', logo:DEFAULT_IMAGE, image:DEFAULT_IMAGE, telephone:'+37368067486', priceRange:'$$', currenciesAccepted:'MDL', address:{ '@type':'PostalAddress', streetAddress:'str. Romană 66/2', addressLocality:'Ungheni', addressCountry:'MD' }, sameAs:['https://www.instagram.com/nailmania_md'] };
const homeCategoryLinks = categories.map((category) => `<li><a href="/category/${encodeURIComponent(category.id)}">${escapeHtml(category.label)}</a></li>`).join('');
const homeProductLinks = catalog.filter(available).slice(0, 24).map((product) => `<li><a href="/product/${encodeURIComponent(product.key)}">${escapeHtml(product.name)}</a> — ${escapeHtml(product.price)} lei</li>`).join('');
fs.writeFileSync(path.join(DIST, 'index.html'), shell({ title:homeTitle, description:homeDescription, canonical:SITE+'/', schema:storeSchema }, `<h1>Produse profesionale pentru manichiură și pedichiură</h1><p>${escapeHtml(homeDescription)}</p><h2>Categorii</h2><ul>${homeCategoryLinks}</ul><h2>Produse recomandate</h2><ul>${homeProductLinks}</ul>`));

writeRoute('/checkout', { title:'Finalizarea comenzii | Nail Mania', description:'Finalizarea comenzii Nail Mania.', canonical:SITE+'/checkout', robots:'noindex,nofollow' }, '<h1>Finalizarea comenzii</h1>');

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${urls.map((url) => `  <url>\n    <loc>${escapeXml(url.loc)}</loc>\n    <priority>${url.priority}</priority>${url.image ? `\n    <image:image><image:loc>${escapeXml(url.image)}</image:loc><image:title>${escapeXml(url.imageTitle)}</image:title></image:image>` : ''}\n  </url>`).join('\n')}\n</urlset>\n`;
fs.writeFileSync(path.join(DIST, 'sitemap.xml'), sitemap);
console.log(`SEO: ${catalog.length} products, ${categories.length} categories, ${brands.length} brands, ${urls.length} sitemap URLs`);
