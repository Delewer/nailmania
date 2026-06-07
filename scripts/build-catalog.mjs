/* Build src/catalog.json + src/categories.json from the product spreadsheet.

   Data source (priority):
     1. Google Sheets — set env CATALOG_SHEET_URL to the sheet's
        "File → Share → Publish to web → (this tab) → CSV" link.
     2. local nailmania-sheet.csv (CSV; an ODS file also works) — offline fallback / default.

   Run: npm run catalog   (re-run whenever the price list changes). */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const ROOT = process.cwd();
const LOCAL = path.join(ROOT, 'nailmania-sheet.csv');
const SHEET_URL = process.env.CATALOG_SHEET_URL || '';

// ---- 1. load spreadsheet rows (Google Sheets CSV, or the local ODS) ----
const decodeXml = (s) => s
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .trim();

function odsRows() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ods-'));
  execSync(`unzip -o "${LOCAL}" content.xml -d "${dir}"`, { stdio: 'ignore' });
  const xml = readFileSync(path.join(dir, 'content.xml'), 'utf8');
  const out = [];
  const rowRe = /<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g;
  const cellRe = /<table:table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    let cm; cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(rm[1]))) {
      const rep = +((cm[1] || '').match(/number-columns-repeated="(\d+)"/)?.[1] || 1);
      const ps = [...(cm[2] || '').matchAll(/<text:p[^>]*>([\s\S]*?)<\/text:p>/g)].map((m) => decodeXml(m[1]));
      const val = ps.join(' ').trim();
      for (let i = 0; i < Math.min(rep, 64); i++) cells.push(val);
    }
    out.push(cells);
  }
  return out;
}

// minimal RFC-4180 CSV parser; auto-detects "," vs ";" delimiter
function csvRows(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const delim = first.split(';').length > first.split(',').length ? ';' : ',';
  const out = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); out.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); out.push(row); }
  return out.map((r) => r.map((x) => x.trim()));
}

// local file may be an ODS (zip) or a plain CSV — handle both
function localRows() {
  const buf = readFileSync(LOCAL);
  if (buf[0] === 0x50 && buf[1] === 0x4b) return odsRows();             // "PK" → ODS zip
  return csvRows(buf.toString('utf8').replace(/^﻿/, ''));          // plain CSV
}

let rows;
if (SHEET_URL) {
  console.log('Loading catalog from Google Sheet…');
  // cache-buster + no-store so each build pulls the latest sheet, not a stale copy
  const url = SHEET_URL + (SHEET_URL.includes('?') ? '&' : '?') + 'cb=' + Date.now();
  const res = await fetch(url, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`Sheet fetch failed (HTTP ${res.status})`);
  rows = csvRows(await res.text());
} else {
  rows = localRows();
}

// ---- 3. map sheet category -> site category id (must exist in CATS, data.js) ----
const norm = (s) => (s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

const CAT_MAP = {
  'culori': 'gellac',
  'dannytiny': 'gellac',
  'alungire': 'alungire',
  'baze': 'baze',
  'topuri': 'topuri',
  'instrumente': 'instrumente',
  'gene': 'gene',
  'sprancene': 'sprancene',
  'accesuare pentru mesteri': 'accesuare',
  'design': 'design',
  'slidiz': 'slidiz',
  'tehnica': 'tehnica',
  'ingrijire': 'ingrijire',
  'epilare': 'epilare',
  'bituri': 'bituri',
  'lichide': 'lichide',
  'pedichiura': 'pedichiura',
  'sterilizare si dezinfectare': 'sterilizare',
  'solutii pregatitoare': 'solutii',
  'materiale': 'materiale',
};
const KNOWN_CATS = new Set(Object.values(CAT_MAP));
// any category the client adds in the sheet that isn't mapped above gets a
// stable auto-generated id (so new categories appear without touching the code)
const slug = (s) => norm(s).replace(/\s+/g, '-').slice(0, 40) || 'altele';

// ---- 3b. Romanian -> Russian product-name translation ----
// Names are brand + (mostly English) nail terms + size + number. We translate the
// Romanian words/connectors/units and leave brands, numbers and the English terms
// that Russian nail masters already use (Top, Base, Gel, Builder, Cat Eye, …).
const RU_PHRASES = {
  'capete de freza':'Насадка для фрезы', 'capat de freza':'Насадка для фрезы',
  'baza din lemn':'деревянная база', 'baza metalica':'металлическая база',
  'de unica folosinta':'одноразовые', 'unica folosinta':'одноразовые',
  'set pentru':'Набор для',
  'pentru ombre':'для омбре', 'pentru gene':'для ресниц', 'pentru sprancene':'для бровей',
  'pentru unghii':'для ногтей', 'pentru manichiura':'для маникюра', 'pentru pedichiura':'для педикюра',
  'pentru cuticule':'для кутикулы', 'pentru cuticula':'для кутикулы', 'pentru laminare':'для ламинирования',
  'pentru maini':'для рук', 'pentru calcaie':'для пяток', 'pentru calcai':'для пяток',
  'pentru fata':'для лица', 'pentru epilare':'для эпиляции', 'pentru praf':'для пыли',
  'de masa':'настольный',
};
const RU_WORDS = {
  pentru:'для', din:'из', cu:'с', si:'и', in:'в', set:'Набор', fara:'без',
  cartus:'Картридж', otel:'сталь', puf:'ворс', plic:'пакетик', reutilizabile:'многоразовые',
  pila:'Пилка', pile:'Пилки', freza:'Фреза', freze:'Фрезы', freze:'Фрезы', capete:'Насадки',
  ceara:'Воск', clesti:'Кусачки', cleste:'Кусачки', foarfeca:'Ножницы', foarfece:'Ножницы',
  pensula:'Кисть', pensule:'Кисти', penseta:'Пинцет', penceta:'Пинцет', pinceta:'Пинцет',
  crema:'Крем', ulei:'Масло', lampa:'Лампа', maner:'Ручка', perie:'Щётка', periute:'Щётки',
  servetele:'Салфетки', betisoare:'Палочки', manusi:'Перчатки', masti:'Маски', masca:'Маска',
  slapi:'Тапочки', container:'Контейнер', recipient:'Контейнер', solutie:'Раствор',
  degresant:'Обезжириватель', adeziv:'Клей', talc:'Тальк', pungi:'Пакеты', punga:'Пакет',
  suport:'Подставка', tava:'Лоток', tipse:'Типсы', tipsuri:'Типсы', sabloane:'Формы', sablon:'Форма',
  forme:'Формы', forma:'Форма', banda:'Полоска', benzi:'Полоски', disc:'Диск', aspirator:'Пылесос',
  topitor:'Воскоплав', prosop:'Простыня', cersaf:'Простыня', cearsaf:'Простыня', bol:'Чаша',
  spatule:'Шпатели', spatula:'Шпатель', stichere:'Стикеры', stickere:'Стикеры',
  crystale:'Кристаллы', cristale:'Кристаллы', cristal:'Кристалл', flori:'Цветы',
  gene:'ресницы', sprancene:'брови', unghii:'ногти', cuticule:'кутикула',
  rosie:'красная', rosu:'красный', verde:'зелёный', albastru:'синий', albastra:'синяя',
  negru:'чёрный', neagra:'чёрная', alb:'белый', alba:'белая', roz:'розовый',
  auriu:'золотой', argintiu:'серебряный', curbura:'для изгиба', lemn:'дерево',
};
// FNV-1a → short base36 string (stable id fallback for products without a SKU)
const fnv = (s)=>{ let h=2166136261>>>0; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619)>>>0; } return h.toString(36); };
const esc = (s)=> s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bound = (k)=> new RegExp('(?<![\\p{L}\\p{N}])'+esc(k)+'(?![\\p{L}\\p{N}])', 'giu');
const RULES = [
  ...Object.entries(RU_PHRASES),
  ...Object.entries(RU_WORDS),
].sort((a,b)=> b[0].length - a[0].length).map(([k,v])=> [bound(k), v]);
const UNITS = [
  [/(\d)\s?ml\b/giu,'$1 мл'], [/(\d)\s?kg\b/giu,'$1 кг'], [/(\d)\s?gr\b/giu,'$1 г'],
  [/(\d)\s?g\b/giu,'$1 г'], [/(\d)\s?buc\b/giu,'$1 шт'], [/(\d)\s?cm\b/giu,'$1 см'],
  [/(\d)\s?mm\b/giu,'$1 мм'], [/(\d)\s?w\b/giu,'$1 Вт'],
];
function ruName(s){
  let out = s;
  for(const [re,rep] of RULES) out = out.replace(re, rep);
  for(const [re,rep] of UNITS) out = out.replace(re, rep);
  return out.replace(/\bde\b/giu,' ').replace(/\s{2,}/g,' ').replace(/\s+([)\].,])/g,'$1').trim();
}

// ---- 4. locate the header row + columns (so adding an Image column "just works") ----
const HMAP = {
  brand:['brand','marca'], code:['sku','cod','code','articol'],
  cat:['category','grupa','categorie'], title:['title','denumire','name','nume'],
  desc:['text','descriere','description','desc'], qty:['quantity','cantitate','stoc','stock'],
  price:['price','pret','pretul'], priceOld:['price old','old','pret vechi','pretul vechi'],
  image:['image','photo','poza','imagine','foto','img','url','link'],
};
let col = null;
let headerIdx = rows.findIndex(r => r.map(norm).some(c => HMAP.title.includes(c)));
if (headerIdx >= 0) {
  const head = rows[headerIdx].map(norm);
  col = Object.fromEntries(Object.entries(HMAP).map(([k, names]) => [k, head.findIndex(c => names.includes(c))]));
} else {                                  // fallback: original fixed layout
  headerIdx = 0;
  col = { brand:0, code:1, cat:2, title:3, desc:4, qty:5, price:6, priceOld:7, image:-1 };
}
const cell = (r, key) => (col[key] >= 0 ? (r[col[key]] || '').trim() : '');

// every "Characteristics:<Label>" column becomes a product spec (label = text after the colon)
const specCols = (rows[headerIdx] || [])
  .map((h, idx) => ({ idx, raw: h }))
  .filter(c => norm(c.raw).startsWith('characteristics'))
  .map(c => ({ idx: c.idx, label: (c.raw.split(':').pop() || c.raw).trim() }));

// ---- 5. build product records ----
const products = [];
const catLabels = {};               // category id -> human label (for auto-created cats)
let n = 0;
for (const r of rows.slice(headerIdx + 1)) {
  const title = cell(r, 'title');
  const catRaw = cell(r, 'cat');
  const price = parseFloat(cell(r, 'price').replace(',', '.'));
  const priceOld = parseFloat(cell(r, 'priceOld').replace(',', '.'));

  if (!title || !catRaw) continue;
  if (!Number.isFinite(price)) continue;

  const cat = CAT_MAP[norm(catRaw)] || slug(catRaw);
  if (!catLabels[cat]) catLabels[cat] = catRaw;

  const image = cell(r, 'image');
  const specs = specCols
    .map(({ idx, label }) => ({ label, value: (r[idx] || '').trim() }))
    .filter(s => s.value);
  const code = cell(r, 'code');
  const brand = cell(r, 'brand') || 'Fără brand';
  const qtyN = parseInt(cell(r, 'qty').replace(/[^\d-]/g, ''), 10);  // stock from Quantity column
  // stable identity for URLs / cart / favorites: SKU when present, else a
  // deterministic hash of brand+name (survives catalog rebuilds; row id does not)
  const key = code || ('x' + fnv(brand + '|' + title + '|' + cat + '|' + price));
  products.push({
    id: 100000 + (++n),
    key,
    code,
    cat,
    brand,
    name: title,
    nameRu: ruName(title),
    price,
    old: Number.isFinite(priceOld) && priceOld > price ? priceOld : 0,
    desc: cell(r, 'desc'),
    ...(Number.isFinite(qtyN) ? { stock: qtyN } : {}),  // 0 → "out of stock"; blank → assume in stock
    ...(image ? { image } : {}),         // supplier image URL, when the sheet has one
    ...(specs.length ? { specs } : {}),  // Characteristics:* columns from the sheet
  });
}

// guard: identity keys must be unique (URLs / cart / favorites depend on it)
const keys = new Set();
const keyDupes = products.filter(p => keys.size === keys.add(p.key).size);
if (keyDupes.length) console.warn(`! ${keyDupes.length} duplicate identity keys:`, keyDupes.map(p=>p.key).slice(0,10));

writeFileSync(path.join(ROOT, 'src', 'catalog.json'), JSON.stringify(products) + '\n');

// categories actually used (id + label + count), busiest first → src/categories.json
const catList = Object.entries(catLabels)
  .map(([id, label]) => ({ id, label, count: products.filter(p => p.cat === id).length }))
  .sort((a, b) => b.count - a.count);
writeFileSync(path.join(ROOT, 'src', 'categories.json'), JSON.stringify(catList) + '\n');

// ---- 6. report ----
const cats = {};
for (const p of products) (cats[p.cat] ||= new Set()).add(p.brand);
console.log(`✓ ${products.length} products -> src/catalog.json`);
console.log(`✓ ${catList.length} categories -> src/categories.json (source: ${SHEET_URL ? 'Google Sheet' : 'local file'})\n`);
for (const [c, set] of Object.entries(cats).sort())
  console.log(`  ${c.padEnd(14)} ${String(products.filter(p => p.cat === c).length).padStart(4)} items · ${set.size} brand(s)`);
const fresh = catList.filter(c => !KNOWN_CATS.has(c.id));
if (fresh.length) { console.log('\n  new categories (auto-created from the sheet):'); for (const c of fresh) console.log(`   "${c.label}" → ${c.id} (${c.count})`); }
