/* Match downloaded Tilda photos to catalog products by name, and write them into
 * photos.csv (SKU,Photo) — the single source of product photos used by the build.
 *
 * In : src/catalog.json            (canonical products; stable `key` = SKU)
 *      scripts/tilda-photos.json   (Tilda title/brand -> downloaded files)
 *      photos.csv                  (existing bindings — preserved where Tilda has none)
 * Out: photos.csv                  ( "SKU","local path(s)" )  LOCAL paths, self-hosted.
 *
 * Conservative: EXACT normalized name match only (no fuzzy) so a product never
 * gets the wrong photo. Tilda (official + local) wins over older entries; existing
 * bindings for products Tilda doesn't cover are kept.
 *
 * Run: node scripts/match-tilda-photos.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'catalog.json'), 'utf8'));
const tilda = JSON.parse(fs.readFileSync(path.join(__dirname, 'tilda-photos.json'), 'utf8'));
const CSV = path.join(ROOT, 'photos.csv');

/* --- tiny CSV parse/quote (comma, "" quoting) --- */
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const qt = (s) => '"' + String(s).replace(/"/g, '""') + '"';

// existing photos.csv -> { SKU: Photo }
const existing = {};
try {
  const rows = parseCSV(fs.readFileSync(CSV, 'utf8'));
  const h = (rows[0] || []).map((x) => x.toLowerCase().trim());
  const si = h.indexOf('sku'), pi = h.indexOf('photo');
  if (si >= 0 && pi >= 0) for (const r of rows.slice(1)) { const k = (r[si] || '').trim(); const v = (r[pi] || '').trim(); if (k && v) existing[k] = v; }
} catch { /* no file yet */ }
const existingCount = Object.keys(existing).length;

// normalize a product name to a tight, space-free comparison key
const norm = (s) => (s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&amp;/g, ' ').replace(/&/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim().replace(/\s+/g, '');
const brandKey = (brand, title) => {
  const b = norm(brand === 'Fără brand' ? '' : brand);
  return b ? b + '|' + norm(title) : norm(title);
};

// index Tilda entries by brand+title and title-only (first wins; flag dupes)
const byBrand = new Map(), byTitle = new Map(), titleDupes = new Set();
for (const e of tilda) {
  if (!e.files || !e.files.length) continue;
  const bk = brandKey(e.brand, e.title), tk = norm(e.title);
  if (!byBrand.has(bk)) byBrand.set(bk, e);
  if (byTitle.has(tk)) titleDupes.add(tk); else byTitle.set(tk, e);
}

const out = { ...existing };           // start from existing, Tilda overwrites matches
let matched = 0, replaced = 0, ambiguous = 0;
const unmatched = [];
for (const p of catalog) {
  const bk = brandKey(p.brand, p.name), tk = norm(p.name);
  let e = byBrand.get(bk);
  if (!e && byTitle.has(tk)) { if (titleDupes.has(tk)) ambiguous++; else e = byTitle.get(tk); }
  if (!e) { if (!existing[p.key]) unmatched.push(p); continue; }
  const paths = e.files.map((f) => 'images/tilda/' + f).join(' ');
  if (existing[p.key] && existing[p.key] !== paths) replaced++;
  out[p.key] = paths;
  matched++;
}

// write photos.csv sorted by SKU
const keys = Object.keys(out).sort();
const csv = '﻿' + ['SKU,Photo'].concat(keys.map((k) => `${qt(k)},${qt(out[k])}`)).join('\n') + '\n';
fs.writeFileSync(CSV, csv);

console.log(`existing photos.csv : ${existingCount} rows`);
console.log(`matched to Tilda    : ${matched}  (replaced ${replaced} older bindings)`);
console.log(`ambiguous skipped   : ${ambiguous}  (duplicate titles)`);
console.log(`preserved (non-Tilda): ${keys.length - matched} rows`);
console.log(`photos.csv total    : ${keys.length} rows`);
console.log(`unmatched products  : ${unmatched.length}`);
console.log('\nSample unmatched (first 20):');
for (const p of unmatched.slice(0, 20)) console.log(`  [${p.cat}] ${p.brand} | ${p.name}`);
