/* Regenerate nailmania-sheet.csv from the authoritative price list
 * (1listaproduse06.06gata.csv: ;cod;denumire;grupa;pretul;descriere;brand).
 * The site must contain exactly the products in that file — nothing else.
 * Run: node scripts/import-list.mjs   then   npm run catalog
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, '1listaproduse06.06gata.csv');
const OUT = path.join(ROOT, 'nailmania-sheet.csv');

// quote-aware CSV parser, auto delimiter (matches build-catalog.mjs)
function csvRows(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const delim = first.split(';').length > first.split(',').length ? ';' : ',';
  const out = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); out.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f.length || row.length) { row.push(f); out.push(row); }
  return out.map((r) => r.map((x) => x.trim()));
}

const rows = csvRows(readFileSync(SRC, 'utf8').replace(/^﻿/, ''));
const hi = rows.findIndex((r) => r.map((x) => x.toLowerCase()).includes('denumire'));
const H = rows[hi].map((x) => x.toLowerCase());
const ci = { cod: H.indexOf('cod'), den: H.indexOf('denumire'), gr: H.indexOf('grupa'), pret: H.indexOf('pretul'), desc: H.indexOf('descriere'), brand: H.indexOf('brand') };

const fixBrand = (b) => {
  b = (b || '').trim().replace(/\s{2,}/g, ' ');
  if (/^DNK'aDNK'a$/i.test(b)) return "DNK'a";          // source typo
  return b;
};

// brand inferred from the title when the source `brand` column is empty
// (order matters; first match wins). Only clear, real brand names — generic
// items (Aspirator, Capete de freza, Tavă, Perie…) stay "Fără brand".
const BRAND_FROM_TITLE = [
  [/^DNK'a/i, "DNK'a"],
  [/^Global\s*Fashion/i, 'Global Fashion'],
  [/^MP[\s-]/, 'MP'],
  [/^Ritz\b/i, 'Ritz'],
  [/Dolly'?s?\s*Lash/i, "Dolly's Lash"],
  [/Blueque/i, 'Blueque'],
  [/Ledme/i, 'Ledme'],
  [/GT\s*Sonic/i, 'GT Sonic'],
  [/Lysoformin/i, 'Lysoformin'],
  [/Blanidas/i, 'Blanidas'],
  [/Bilysna/i, 'Bilysna'],
  [/Neoseptin/i, 'Neoseptin'],
  [/Aerodisin/i, 'Aerodisin'],
  [/Experttouch/i, 'Experttouch'],
];
const inferBrand = (title) => { for (const [re, b] of BRAND_FROM_TITLE) if (re.test(title)) return b; return ''; };

// title-based category overrides (win over the source `grupa`); first match wins.
//   not: optional negative guard so "Adaptor pentru Lampa UV" stays a tehnica accessory
const CAT_OVERRIDE = [
  { re: /capete de freza|cap de freza/i, to: 'Bituri' },
  { re: /lanterna|lamp/i, not: /adaptor/i, to: 'Instrumente' },
];
const overrideCat = (title) => {
  for (const o of CAT_OVERRIDE) if (o.re.test(title) && !(o.not && o.not.test(title))) return o.to;
  return '';
};

const qt = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
const header = ['Brand', 'SKU', 'Category', 'Title', 'Text', 'Quantity', 'Price', 'Price Old'];
const out = [header.map(qt).join(',')];

let kept = 0, skipped = 0, inferred = 0, recat = 0;
for (const r of rows.slice(hi + 1)) {
  const title = (r[ci.den] || '').trim();
  const grupa = (r[ci.gr] || '').trim();
  const price = parseFloat((r[ci.pret] || '').replace(',', '.'));
  if (!title || !grupa || !Number.isFinite(price)) { skipped++; continue; }   // separator/blank rows

  let brand = fixBrand(r[ci.brand]);
  if (!brand) { const b = inferBrand(title); if (b) { brand = b; inferred++; } }

  const ov = overrideCat(title);
  const category = ov || grupa;
  if (ov && ov.toLowerCase() !== grupa.toLowerCase()) recat++;

  out.push([
    brand,
    (r[ci.cod] || '').trim(),
    category,
    title,
    (r[ci.desc] || '').trim(),
    '',                       // Quantity (blank => in stock)
    (r[ci.pret] || '').trim(),
    '',                       // Price Old
  ].map(qt).join(','));
  kept++;
}
console.log(`  brands inferred from title: ${inferred} | category overrides applied: ${recat}`);

writeFileSync(OUT, '﻿' + out.join('\r\n') + '\r\n');
console.log(`✓ wrote ${path.basename(OUT)} — ${kept} products (skipped ${skipped} blank rows)`);
