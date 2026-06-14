/* Rebuild photos.csv from scratch by EXACT title match against the current catalog.
 *
 * Why: product photos were bound by SKU, but SKUs differ across data sources
 * (Tilda store vs the authoritative price list), so after the catalog was rebuilt
 * many products inherited a wrong photo (e.g. a gel-lac showing a sugar-paste jar).
 * The only reliable join is the normalized TITLE. We also keep only photos that are
 * actually uploaded to R2 (present in the existing photos.csv values), so no 404s,
 * and we DROP the unreliable products/<SKU>.jpg + drive/<id> bindings.
 *
 * In : src/catalog.json, scripts/tilda-photos.json, photos.csv (for the uploaded set)
 * Out: photos.csv  ("SKU","r2url r2url …")  — only correct, exact-title matches
 * Run: node scripts/rematch-photos.mjs   then   npm run catalog
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const R2 = 'https://pub-bdc9e7e148164007b19e2753ba1b49b9.r2.dev/';

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'catalog.json'), 'utf8'));
const tilda = JSON.parse(fs.readFileSync(path.join(__dirname, 'tilda-photos.json'), 'utf8'));

function parseCSV(text){ const rows=[];let row=[],f="",q=false;text=text.replace(/^﻿/,"");
  for(let i=0;i<text.length;i++){const c=text[i];
    if(q){if(c==='"'){if(text[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}
    else if(c==='"')q=true;else if(c===','){row.push(f);f="";}
    else if(c==='\n'){row.push(f);rows.push(row);row=[];f="";}else if(c!=='\r')f+=c;}
  if(f.length||row.length){row.push(f);rows.push(row);} return rows; }
const qt = (s)=> '"'+String(s).replace(/"/g,'""')+'"';
const norm = (s)=> (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')
  .replace(/&amp;/g,' ').replace(/&/g,' ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,'');
const toR2 = (url)=> R2 + url.split('/').pop().trim();

// set of photos already uploaded to R2 (from the existing photos.csv values)
const uploaded = new Set();
try {
  const rows = parseCSV(fs.readFileSync(path.join(ROOT,'photos.csv'),'utf8'));
  for (const r of rows.slice(1)) for (const u of (r[1]||'').split(/\s+/)) if (u) uploaded.add(u.trim());
} catch {}

// normalized Tilda title -> [R2 urls that are actually uploaded]
const byTitle = new Map();
for (const e of tilda) {
  const k = norm(e.title); if (!k) continue;
  const urls = (e.urls||[]).map(toR2).filter(u => uploaded.has(u));
  if (urls.length && !byTitle.has(k)) byTitle.set(k, urls);
}

// exact title match: each product gets the photo of the SAME title, or none
const out = [['SKU','Photo'].map(qt).join(',')];
let matched = 0;
for (const p of catalog) {
  const urls = byTitle.get(norm(p.name));
  if (urls && urls.length) { out.push([p.key, urls.join(' ')].map(qt).join(',')); matched++; }
}

fs.writeFileSync(path.join(ROOT,'photos.csv'), '﻿' + out.join('\r\n') + '\r\n');
console.log(`✓ photos.csv rebuilt — ${matched}/${catalog.length} products matched a Tilda photo by exact title`);
console.log(`  (dropped the old SKU-keyed bindings that caused wrong photos)`);
