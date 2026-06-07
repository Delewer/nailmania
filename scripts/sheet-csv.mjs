/* Build a complete, Google-Sheets-ready CSV from the current catalog, with ALL
   columns the site uses (Quantity, Photo, Characteristics:*). Comma-delimited UTF-8.
   Run: node scripts/sheet-csv.mjs  →  nailmania-sheet.csv */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();
const catalog = JSON.parse(readFileSync(path.join(ROOT, 'src', 'catalog.json'), 'utf8'));
let cats = [];
try { cats = JSON.parse(readFileSync(path.join(ROOT, 'src', 'categories.json'), 'utf8')); } catch {}
const catLabel = Object.fromEntries(cats.map((c) => [c.id, c.label]));

// union of characteristic labels, in first-seen order
const specLabels = [];
for (const p of catalog) for (const s of p.specs || []) if (!specLabels.includes(s.label)) specLabels.push(s.label);

const header = ['Brand', 'SKU', 'Category', 'Title', 'Text', 'Quantity', 'Price', 'Price Old', 'Photo',
  ...specLabels.map((l) => 'Characteristics:' + l)];

const rows = catalog.map((p) => {
  const specOf = Object.fromEntries((p.specs || []).map((s) => [s.label, s.value]));
  return [
    p.brand === 'Fără brand' ? '' : (p.brand || ''),
    p.code || '',
    catLabel[p.cat] || p.cat,
    p.name || '',
    p.desc || '',
    typeof p.stock === 'number' ? p.stock : '',
    p.price,
    p.old > 0 ? p.old : '',
    p.image || '',
    ...specLabels.map((l) => specOf[l] || ''),
  ];
});

const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const csv = '﻿' + [header, ...rows].map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
writeFileSync(path.join(ROOT, 'nailmania-sheet.csv'), csv);

console.log(`✓ nailmania-sheet.csv — ${rows.length} products × ${header.length} cols`);
console.log('  columns:', header.join(', '));
