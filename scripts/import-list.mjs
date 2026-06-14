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

const qt = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
const header = ['Brand', 'SKU', 'Category', 'Title', 'Text', 'Quantity', 'Price', 'Price Old'];
const out = [header.map(qt).join(',')];

let kept = 0, skipped = 0;
for (const r of rows.slice(hi + 1)) {
  const title = (r[ci.den] || '').trim();
  const cat = (r[ci.gr] || '').trim();
  const price = parseFloat((r[ci.pret] || '').replace(',', '.'));
  if (!title || !cat || !Number.isFinite(price)) { skipped++; continue; }   // separator/blank rows
  out.push([
    fixBrand(r[ci.brand]),
    (r[ci.cod] || '').trim(),
    cat,
    title,
    (r[ci.desc] || '').trim(),
    '',                       // Quantity (blank => in stock)
    (r[ci.pret] || '').trim(),
    '',                       // Price Old
  ].map(qt).join(','));
  kept++;
}

writeFileSync(OUT, '﻿' + out.join('\r\n') + '\r\n');
console.log(`✓ wrote ${path.basename(OUT)} — ${kept} products (skipped ${skipped} blank rows)`);
