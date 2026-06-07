/* Crawl the public Google Drive folder of DANNY photos, match each photo to a
   catalog SKU (collection + shade number), and write photos.csv (SKU,Photo).
   Photos are served free from Drive via https://lh3.googleusercontent.com/d/<id>.
   Run: node scripts/drive-photos.mjs [ROOT_ID] [--recon] */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const ROOT_ID = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '1mBMuYb7oxysBaT4fbY9caN32F_SNX5pO';
const RECON = process.argv.includes('--recon');
const IMG = /\.(jpe?g|png|webp)$/i;
const lh3 = (id) => `https://lh3.googleusercontent.com/d/${id}`;

const listFolder = async (id) => {
  const html = await (await fetch(`https://drive.google.com/embeddedfolderview?id=${id}#list`)).text();
  const re = /id="entry-([A-Za-z0-9_-]{20,})"[\s\S]*?flip-entry-title">([^<]+)/g;
  const out = []; let m;
  while ((m = re.exec(html))) out.push({ id: m[1], name: m[2].trim() });
  return out;
};

// ---- crawl: root → subfolders → image files ----
const root = await listFolder(ROOT_ID);
const subfolders = root.filter((e) => !/\.\w{2,4}$/.test(e.name));
const photos = [];
for (const sf of subfolders) {
  for (const it of await listFolder(sf.id)) if (IMG.test(it.name)) photos.push({ collection: sf.name, file: it.name, id: it.id });
}
const byCol = {};
for (const p of photos) (byCol[p.collection] ||= []).push(p);
console.log(`Folders: ${subfolders.length} | images: ${photos.length}`);
if (RECON) { for (const [c, f] of Object.entries(byCol).sort()) console.log(`  ${c.padEnd(34)} ${f.length}`); process.exit(0); }

// ---- shade-number extraction (works for filenames and Titles) ----
const lastNum = (s) => {
  const x = s
    .replace(/\.[a-z0-9]{2,4}$/i, '')          // file extension
    .replace(/_\d+$/, '')                       // _1 / _2 duplicate suffix
    .replace(/\d+\s*-?\s*(ml|мл|gr?|г)\b/gi, ' '); // size/weight tokens
  const n = x.match(/\d+/g);
  return n ? parseInt(n[n.length - 1], 10) : null; // trailing number = shade
};
const shadeNum = lastNum;
// Titles: prefer the explicit "#NNN" shade; fall back to trailing number (e.g. "Yogurt Base 12ml 001")
const titleNum = (t) => { const m = t.match(/#\s*0*(\d+)/); return m ? parseInt(m[1], 10) : lastNum(t); };

// ---- folder → catalog line (Title predicate) ----
const has = (...w) => (t) => w.every((x) => t.toLowerCase().includes(x));
const FOLDER_MAP = {
  'основна колекція гель-лаків': has('danny color'),
  '1step': has('1step'),
  'Glass cat': has('glass cat'),
  'ice cat': has('ice cat'),
  'Soft luxe cat': has('soft luxe'),
  'Neon cat': has('neon cat'),
  'dancing cat eye': has('dancing'),
  'platinum gel': has('platinum gel'),
  'fire flash': has('fire flash'),
  'flash': has('flash crystal'),
  'Builder gel': (t) => /builder gel/i.test(t) && !/(chocolate|diamond|milk|rainbow|candy|aurora|bloom|party|premium|red |white|veil)/i.test(t),
  'Builder Gel Diamond Veil': has('diamond veil'),
  'Builder Gel «Chocolate Mood»': has('builder gel chocolate'),
  'Milk Blossom': has('milk blossom'),
  'LIGHT GEL': has('light gel'),
  'liquid polygel': has('polygel'),
  'Vitrage cat': has('vitrage'),
  'DANNY Sweeties 12 ml': has('sweeties'),
  'DANNY YOGURT BASE': has('yogurt base'),
  'Base My Love': has('my love base'),
  'ding_dots_12ml': has('neon dots'),
  'Lego': has('lego'),
};

const catalog = JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'catalog.json'), 'utf8'));
const danny = catalog.filter((p) => /danny/i.test(p.brand));

const map = {};            // SKU -> url
const report = [];
const unmapped = [];
for (const [col, files] of Object.entries(byCol)) {
  const pred = FOLDER_MAP[col];
  if (!pred) { unmapped.push([col, files.length]); continue; }
  const line = danny.filter((p) => pred(p.name) && titleNum(p.name) != null);
  const numToSku = {};
  for (const p of line) if (!(titleNum(p.name) in numToSku)) numToSku[titleNum(p.name)] = p.code || p.key;
  let matched = 0;
  for (const f of files.sort((a, b) => (/\.jpe?g$/i.test(b.file) ? 1 : 0) - (/\.jpe?g$/i.test(a.file) ? 1 : 0))) {
    const n = shadeNum(f.file);
    const sku = n != null ? numToSku[n] : null;
    if (sku && !map[sku]) { map[sku] = lh3(f.id); matched++; }
  }
  report.push([col, matched, line.length, files.length]);
}

// keep any photo URLs already present in the catalog (e.g. existing Cloudinary links)
for (const p of catalog) if (p.image && (p.code || p.key) && !map[p.code || p.key]) map[p.code || p.key] = p.image;

writeFileSync(path.join(process.cwd(), 'photos.csv'),
  '﻿' + 'SKU,Photo\r\n' + Object.entries(map).map(([s, u]) => `"${s}","${u}"`).join('\r\n') + '\r\n');

console.log(`\nMatched photos → ${Object.keys(map).length} SKUs (photos.csv)\n`);
console.log('  collection                          matched / line / photos');
for (const [c, m, l, f] of report.sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(34)} ${String(m).padStart(4)} / ${String(l).padStart(3)} / ${f}`);
if (unmapped.length) { console.log('\n  not auto-mapped (manual):'); for (const [c, n] of unmapped) console.log(`   ${c} (${n})`); }
