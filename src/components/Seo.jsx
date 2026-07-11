import React from 'react'
import { useLocation } from 'react-router-dom'
import { findCategory, productGallery } from '../data.js'
import { findProduct, inStock } from '../catalog-data.js'

const SITE = 'https://nailmania.md';
const DEFAULT_IMAGE = SITE + '/images/logo-high.png';
const DEFAULT_TITLE = 'Nail Mania Moldova — produse profesionale pentru manichiură';
const DEFAULT_DESC = 'Magazin online cu produse profesionale pentru manichiură, pedichiură și epilare. Peste 1800 de produse, livrare în toată Moldova și magazin în Ungheni.';

const clean = (value, max = 160) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const absoluteImage = (value) => {
  const image = String(value || '').split(/[\s,]+/).find(Boolean);
  if (!image) return DEFAULT_IMAGE;
  return /^https?:\/\//.test(image) ? image : SITE + '/' + image.replace(/^\//, '');
};
const setMeta = (selector, attr, value) => {
  let element = document.head.querySelector(selector);
  if (!element) {
    element = document.createElement(selector.startsWith('link') ? 'link' : 'meta');
    if (selector.includes('name=')) element.setAttribute('name', selector.match(/name="([^"]+)/)?.[1] || '');
    if (selector.includes('property=')) element.setAttribute('property', selector.match(/property="([^"]+)/)?.[1] || '');
    if (selector.startsWith('link')) element.setAttribute('rel', 'canonical');
    document.head.appendChild(element);
  }
  element.setAttribute(attr, value);
};

function routeSeo(pathname) {
  const canonical = SITE + (pathname === '/' ? '/' : pathname.replace(/\/$/, ''));
  const base = { title: DEFAULT_TITLE, description: DEFAULT_DESC, canonical, image: DEFAULT_IMAGE, type: 'website', robots: 'index,follow,max-image-preview:large' };

  if (pathname === '/') {
    return {
      ...base,
      schema: { '@context':'https://schema.org', '@type':'Store', '@id':SITE+'/#store', name:'Nail Mania', url:SITE+'/', logo:DEFAULT_IMAGE, image:DEFAULT_IMAGE, telephone:'+37368067486', priceRange:'$$', currenciesAccepted:'MDL', address:{ '@type':'PostalAddress', streetAddress:'str. Romană 66/2', addressLocality:'Ungheni', addressCountry:'MD' }, sameAs:['https://www.instagram.com/nailmania_md'] },
    };
  }

  const productMatch = pathname.match(/^\/product\/([^/]+)$/);
  if (productMatch) {
    const product = findProduct(decodeURIComponent(productMatch[1]));
    if (!product) return { ...base, title:'Produs negăsit | Nail Mania', robots:'noindex,follow' };
    const description = clean(`${product.name} de la ${product.brand}, preț ${product.price} lei. ${product.desc || 'Produs profesional cu livrare în toată Moldova.'}`);
    const image = absoluteImage(productGallery(product)[0]);
    return {
      ...base,
      title: clean(`${product.name} — ${product.price} lei | Nail Mania`, 70),
      description,
      image,
      type:'product',
      schema: {
        '@context':'https://schema.org', '@type':'Product', name:product.name, description, image:[image], sku:product.code || product.key,
        brand:{ '@type':'Brand', name:product.brand },
        offers:{ '@type':'Offer', url:canonical, priceCurrency:'MDL', price:product.price, itemCondition:'https://schema.org/NewCondition', availability:inStock(product)?'https://schema.org/InStock':'https://schema.org/OutOfStock', seller:{ '@type':'Organization', name:'Nail Mania' } },
      },
    };
  }

  const categoryMatch = pathname.match(/^\/category\/([^/]+)$/);
  if (categoryMatch) {
    const category = findCategory(decodeURIComponent(categoryMatch[1]));
    if (!category) return { ...base, title:'Categorie negăsită | Nail Mania', robots:'noindex,follow' };
    const description = clean(`Cumpără ${category.ro.toLowerCase()} și produse profesionale pentru salon de la Nail Mania. Livrare rapidă în Ungheni, Chișinău și toată Moldova.`);
    return { ...base, title:clean(`${category.ro} — produse profesionale | Nail Mania`, 70), description, schema:{ '@context':'https://schema.org', '@type':'CollectionPage', name:category.ro, description, url:canonical } };
  }

  const brandMatch = pathname.match(/^\/brand\/([^/]+)$/);
  if (brandMatch) {
    const brand = decodeURIComponent(brandMatch[1]);
    const description = clean(`Produse profesionale ${brand} pentru manichiură și salon. Prețuri actuale, stoc și livrare în toată Moldova de la Nail Mania.`);
    return { ...base, title:clean(`${brand} — produse profesionale | Nail Mania`, 70), description, schema:{ '@context':'https://schema.org', '@type':'CollectionPage', name:`Produse ${brand}`, description, url:canonical } };
  }

  if (pathname === '/search') {
    const title = 'Cautare produse | Nail Mania';
    const description = 'Cauta produse profesionale pentru manichiura, pedichiura si salon in catalogul Nail Mania.';
    return { ...base, title, description, robots:'noindex,follow', schema:{ '@context':'https://schema.org', '@type':'WebPage', name:title, description, url:canonical } };
  }

  const pages = {
    '/livrare':['Livrare în Moldova | Nail Mania','Condiții și termene de livrare pentru comenzile Nail Mania în Ungheni, Chișinău, toată Moldova și Europa.'],
    '/plata':['Metode de plată | Nail Mania','Metode de plată disponibile pentru comenzile Nail Mania: numerar, card bancar, transfer și plată la livrare.'],
    '/contacte':['Contacte Nail Mania Ungheni','Magazin Nail Mania: str. Romană 66/2, Ungheni, Moldova. Telefon +373 68 067 486. Comenzi online 24/7.'],
  };
  if (pages[pathname]) return { ...base, title:pages[pathname][0], description:pages[pathname][1], schema:{ '@context':'https://schema.org', '@type':'WebPage', name:pages[pathname][0], description:pages[pathname][1], url:canonical } };
  if (pathname === '/checkout') return { ...base, title:'Finalizarea comenzii | Nail Mania', robots:'noindex,nofollow' };
  return { ...base, title:'Pagină negăsită | Nail Mania', robots:'noindex,follow' };
}

export function Seo() {
  const { pathname } = useLocation();
  React.useEffect(() => {
    const seo = routeSeo(pathname);
    document.title = seo.title;
    setMeta('meta[name="description"]', 'content', seo.description);
    setMeta('meta[name="robots"]', 'content', seo.robots);
    setMeta('link[rel="canonical"]', 'href', seo.canonical);
    setMeta('meta[property="og:type"]', 'content', seo.type);
    setMeta('meta[property="og:title"]', 'content', seo.title);
    setMeta('meta[property="og:description"]', 'content', seo.description);
    setMeta('meta[property="og:url"]', 'content', seo.canonical);
    setMeta('meta[property="og:image"]', 'content', seo.image);
    setMeta('meta[name="twitter:title"]', 'content', seo.title);
    setMeta('meta[name="twitter:description"]', 'content', seo.description);
    setMeta('meta[name="twitter:image"]', 'content', seo.image);
    let script = document.getElementById('seo-jsonld');
    if (!script) { script = document.createElement('script'); script.id = 'seo-jsonld'; script.type = 'application/ld+json'; document.head.appendChild(script); }
    script.textContent = JSON.stringify(seo.schema || {});
  }, [pathname]);
  return null;
}
