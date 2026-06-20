import { CATS, I18N, findCategory, productGallery, productImg } from './data.js';
import catalogUrl from './catalog.json?url';

// ---- Full catalog (generated from the spreadsheet via scripts/build-catalog.mjs) ----
const CATALOG_RAW = await fetch(catalogUrl).then((res)=>{
  if(!res.ok) throw new Error(`Failed to load catalog: ${res.status}`);
  return res.json();
});
const _catMeta = Object.fromEntries(CATS.map(c=>[c.id, c]));
// normalise catalog rows into the same product shape the UI components expect
export const CATALOG = CATALOG_RAW.map(p=>{
  const c = _catMeta[p.cat];
  return {
    ...p,                               // includes stable `key` (SKU or hash fallback)
    ro:p.name, ru:p.nameRu || p.name,   // RU names generated in scripts/build-catalog.mjs
    badge: p.old>p.price ? "sale" : "",
    g: c ? c.g : ["#e7d6dd","#f5ebef"],
    icon: c ? c.icon : "bottle",
    img: p.image ? productGallery(p)[0] : productImg(p.code || p.key || p.id),  // Tilda/supplier photo → local SKU file → gradient
  };
});

// ---- Lookups & helpers ----
// Live product set = real catalog only. Landing rows come from featured()/SALE_PRODUCTS.
export const ALL_PRODUCTS = CATALOG;

// products of a category (catalog only) + the brands available within it
export const productsByCat = (catId)=> CATALOG.filter(p=>p.cat===catId);
export function brandsByCat(catId){
  const counts = new Map();
  for(const p of productsByCat(catId)) counts.set(p.brand, (counts.get(p.brand)||0)+1);
  return [...counts.entries()]
    .sort((a,b)=> b[1]-a[1] || a[0].localeCompare(b[0]))
    .map(([brand,count])=>({brand,count}));
}

// products of a brand (catalog only) + the categories it spans
export const productsByBrand = (brand)=> CATALOG.filter(p=>p.brand===brand);
export function catsByBrand(brand){
  const counts = new Map();
  for(const p of productsByBrand(brand)) counts.set(p.cat, (counts.get(p.cat)||0)+1);
  return [...counts.entries()]
    .sort((a,b)=> b[1]-a[1])
    .map(([cat,count])=>({cat,count}));
}

// real brands from the price list, busiest first (excludes the unbranded bucket)
export const NO_BRAND = "Fără brand";
export const CATALOG_BRANDS = (()=>{
  const counts = new Map();
  for(const p of CATALOG) if(p.brand!==NO_BRAND) counts.set(p.brand,(counts.get(p.brand)||0)+1);
  return [...counts.entries()]
    .sort((a,b)=> b[1]-a[1] || a[0].localeCompare(b[0]))
    .map(([brand,count])=>({brand,count}));
})();

// stable, varied selection of real products for the landing rows.
// (The price list has no hit/new flags, so we spread real items across
//  categories deterministically — same picks on every load.)
const _hash = (x)=>{ let h=(x*2654435761)>>>0; h^=h>>>15; return (h*2246822519>>>0); };
export function featured(seed, n=8){
  const cats = [...new Set(CATALOG.map(p=>p.cat))];
  const out = [], used = new Set();
  for(let i=0; out.length<n && i<2000; i++){
    const pool = productsByCat(cats[(i+seed)%cats.length]);
    if(!pool.length) continue;
    const p = pool[_hash(seed*131+i) % pool.length];
    if(p && !used.has(p.id)){ used.add(p.id); out.push(p); }
  }
  return out;
}
// curated landing collections, driven by the sheet's flag columns (build-catalog.mjs):
//   Summer column -> p.summer ;  Sale/Promo column -> p.promo
// The −30% block also keeps real price-list discounts (Price Old > Price).
export const SUMMER_PRODUCTS = CATALOG.filter(p=>p.summer);
export const SALE_PRODUCTS = CATALOG.filter(p=>p.promo || p.old>p.price);
export const NEW_PRODUCTS = CATALOG.filter(p=>p.isNew);
// look up by stable identity key (SKU or hash fallback) — used by URLs/cart/favorites
export const findProduct = (key)=> ALL_PRODUCTS.find(p=>p.key===key);

// stock comes from the sheet's Quantity column. Only an explicit 0 (or less) means
// out of stock; a blank/unknown quantity is treated as available (safe default).
export const inStock = (p)=> typeof p.stock !== "number" || p.stock > 0;

// real SKU from the price list when present, else a stable generated code
export const productCode = (p)=> p.code || "NM-"+String(p.id).padStart(4,"0");

// bilingual generated description (no real copy in the source data)
export function productDesc(p, lang){
  // the real description from the price list is Romanian only — show it for RO;
  // for other languages fall back to the localized template so the page actually
  // switches language (otherwise RU users see Romanian text)
  if(p.desc && lang === "ro") return [p.desc, ""];
  const L = I18N[lang] || I18N.ro;
  const cat = findCategory(p.cat);
  const catName = cat ? (cat[lang]||cat.ro) : "";
  const a = (p[lang]||p.ro) + " " + L.descA.replace("{brand}", p.brand).replace("{cat}", catName);
  return [a, L.descB];
}

// ---- Product specs (Characteristics:* columns from the price list) ----
const SPEC_LABEL_RU = {
  "Cantitate":"Объём", "Greutate":"Вес", "Putere":"Мощность", "Grit":"Зернистость",
  "Tip":"Тип", "Culoare":"Цвет", "Viteză maximă":"Макс. скорость",
};
const SPEC_COLOR_RU = {
  "Bej":"Бежевый", "Bej – roz":"Бежево-розовый", "Bej deschis":"Светло-бежевый",
  "Alb":"Белый", "Super alb":"Супер белый", "Grafit":"Графит", "Castaniu":"Каштановый",
  "Cafeniu":"Коричневый", "Cafeniu deschis":"Светло-коричневый", "Cafeniu inchis":"Тёмно-коричневый",
  "Roz":"Розовый", "Violet":"Фиолетовый", "Transparent":"Прозрачный", "Maro":"Коричневый",
  "Piersic":"Персиковый", "Laptisor":"Молочный", "Negru":"Чёрный", "Rosu":"Красный",
  "Cu sclipici":"С блёстками",
  "Color":"Цветная", "Transparentă":"Прозрачная",
};
const specValueRu = (v)=>{
  if(SPEC_COLOR_RU[v]) return SPEC_COLOR_RU[v];
  if(/^da$/i.test(v)) return "Да";
  if(/^nu$/i.test(v)) return "Нет";
  return v.replace(/(\d)\s*ml\b/gi,"$1 мл").replace(/(\d)\s*kg\b/gi,"$1 кг")
          .replace(/(\d)\s*g\b/gi,"$1 г").replace(/(\d)\s*W\b/g,"$1 Вт").replace(/rpm/gi,"об/мин");
};
// localized [{label, value}] for a product (RO as-is; RU labels + values translated)
export function productSpecs(p, lang){
  if(!p.specs || !p.specs.length) return [];
  if(lang!=="ru") return p.specs;
  return p.specs.map(s=>({ label: SPEC_LABEL_RU[s.label]||s.label, value: specValueRu(s.value) }));
}
// localized single spec label / value — used by the category-page facet filters
export const specLabel = (label, lang)=> lang==="ru" ? (SPEC_LABEL_RU[label]||label) : label;
export const specValue = (value, lang)=> lang==="ru" ? specValueRu(value) : value;

// faceted filters for a category, derived from product specs (only labels with ≥2 values).
const _FACET_ORDER = ["Tip","Cantitate","Greutate","Putere","Grit"];
const _facetNum = (v)=> parseFloat(String(v).replace(",",".").replace(/[^\d.]/g,""));
export function facetsByCat(catId){
  const labels = new Map();
  for(const p of productsByCat(catId)) for(const s of (p.specs||[])){
    if(!labels.has(s.label)) labels.set(s.label, new Map());
    const m = labels.get(s.label); m.set(s.value, (m.get(s.value)||0)+1);
  }
  const facets = [];
  for(const [label, m] of labels){
    if(m.size < 2) continue;                       // a single-value facet filters nothing
    const values = [...m.entries()].map(([value,count])=>({value,count}));
    if(/\d/.test(values[0].value)) values.sort((a,b)=> _facetNum(a.value)-_facetNum(b.value));
    else values.sort((a,b)=> a.value.localeCompare(b.value));
    facets.push({ label, values });
  }
  facets.sort((a,b)=> (_FACET_ORDER.indexOf(a.label)+1||99) - (_FACET_ORDER.indexOf(b.label)+1||99));
  return facets;
}

// up to `n` other products sharing the category (falls back to bestsellers)
export function relatedProducts(p, n=4){
  const same = ALL_PRODUCTS.filter(x=>x.id!==p.id && x.cat===p.cat);
  const pool = same.length>=n ? same : [...same, ...ALL_PRODUCTS.filter(x=>x.id!==p.id && x.cat!==p.cat)];
  return pool.slice(0,n);
}
