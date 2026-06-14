/* Add the collection flag columns (Summer, Sale) to nailmania-sheet.csv and
 * tag a few example products so the Summer '26 / −30% blocks work out of the box.
 * Idempotent: won't duplicate columns. Edit the marks in the sheet anytime —
 * any non-empty cell = the product is in that collection.
 *
 * Run: node scripts/add-collection-columns.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const FILE = path.join(ROOT, 'nailmania-sheet.csv');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'catalog.json'), 'utf8'));

function parse(t) { const R = []; let r = [], f = '', q = false; t = t.replace(/^﻿/, ''); for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else if (c === '"') q = true; else if (c === ',') { r.push(f); f = ''; } else if (c === '\n') { r.push(f); R.push(r); r = []; f = ''; } else if (c !== '\r') f += c; } if (f.length || r.length) { r.push(f); R.push(r); } return R; }
const qt = (s) => '"' + String(s).replace(/"/g, '""') + '"';

const rows = parse(fs.readFileSync(FILE, 'utf8')).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
const header = rows[0];
const low = header.map((h) => h.trim().toLowerCase());
const skuIdx = low.indexOf('sku');

let iSummer = low.indexOf('summer');
let iSale = low.indexOf('sale');
let iNew = low.indexOf('new');
if (iSummer < 0) { header.push('Summer'); iSummer = header.length - 1; }
if (iSale < 0) { header.push('Sale'); iSale = header.length - 1; }
if (iNew < 0) { header.push('New'); iNew = header.length - 1; }
const width = header.length;

// example tags: a handful of Gel Lac products
const gellac = catalog.filter((p) => p.cat === 'gellac').map((p) => p.code || p.key);
const summerSet = new Set(gellac.slice(0, 8));
const saleSet = new Set(gellac.slice(8, 12));
const newSet = new Set(gellac.slice(12, 20));

let tagged = 0;
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  while (r.length < width) r.push('');
  const sku = (r[skuIdx] || '').trim();
  if (summerSet.has(sku)) { r[iSummer] = 'x'; tagged++; }
  if (saleSet.has(sku)) { r[iSale] = 'x'; tagged++; }
  if (newSet.has(sku)) { r[iNew] = 'x'; tagged++; }
}

fs.writeFileSync(FILE, '﻿' + rows.map((r) => r.map(qt).join(',')).join('\r\n') + '\r\n');
console.log(`columns: Summer(#${iSummer}) Sale(#${iSale}) New(#${iNew}) | cols=${width} | example tags set: ${tagged}`);
console.log(`Summer examples: ${[...summerSet].join(', ')}`);
console.log(`Sale examples:   ${[...saleSet].join(', ')}`);
console.log(`New examples:    ${[...newSet].join(', ')}`);
