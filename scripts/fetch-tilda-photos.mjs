/* Download all product photos from the Tilda store CSV export.
 *
 * Source : store-14142461-*.csv (semicolon-delimited Tilda export)
 * Output : public/images/tilda/<hash>.<ext>   (content dedup by filename)
 * Mapping: scripts/tilda-photos.json + tilda-photos.csv
 *
 * Resumable: skips any image file that already exists.
 *
 * Usage:
 *   node scripts/fetch-tilda-photos.mjs                  # download everything
 *   node scripts/fetch-tilda-photos.mjs --stats          # parse + print stats, no download
 *   node scripts/fetch-tilda-photos.mjs --concurrency 8
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'images', 'tilda');
const MAP_JSON = path.join(__dirname, 'tilda-photos.json');
const MAP_CSV = path.join(ROOT, 'tilda-photos.csv');

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const STATS_ONLY = process.argv.includes('--stats');
const CONC = parseInt(arg('--concurrency', '8'), 10);

// find the CSV
const csvFile = fs.readdirSync(ROOT).find((f) => /^store-\d+.*\.csv$/i.test(f));
if (!csvFile) { console.error('No store-*.csv found in project root'); process.exit(1); }
const raw = fs.readFileSync(path.join(ROOT, csvFile), 'utf8').replace(/^﻿/, '');

/* --- minimal CSV parser: semicolon delimiter, "" quoting --- */
function parseCSV(text, delim = ';') {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const rows = parseCSV(raw);
const header = rows[0];
const col = (name) => header.indexOf(name);
const cUID = col('Tilda UID'), cSKU = col('SKU'), cBrand = col('Brand'),
      cCat = col('Category'), cTitle = col('Title'), cPhoto = col('Photo'),
      cUrl = col('Url'), cParent = col('Parent UID');

const products = [];
const urlSet = new Set();
for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  if (!row || row.length < 5) continue;
  const photo = (row[cPhoto] || '').trim();
  if (!photo) continue;                       // skip rows without photos (editions etc.)
  const urls = photo.split(/\s+/).filter((u) => /^https?:\/\//.test(u));
  if (!urls.length) continue;
  urls.forEach((u) => urlSet.add(u));
  products.push({
    uid: row[cUID] || '', sku: row[cSKU] || '', brand: row[cBrand] || '',
    category: row[cCat] || '', title: row[cTitle] || '', url: row[cUrl] || '',
    parent: row[cParent] || '', urls,
  });
}

const fileOf = (u) => decodeURIComponent(u.split('/').pop().split('?')[0]);

console.log(`CSV            : ${csvFile}`);
console.log(`Rows           : ${rows.length - 1}`);
console.log(`With photos    : ${products.length}`);
console.log(`Photo refs     : ${products.reduce((n, p) => n + p.urls.length, 0)}`);
console.log(`Unique images  : ${urlSet.size}`);

if (STATS_ONLY) process.exit(0);

fs.mkdirSync(OUT, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const urls = [...urlSet];
let done = 0, downloaded = 0, skipped = 0, failed = 0;
const failures = [];

async function getOne(u) {
  const name = fileOf(u);
  const dest = path.join(OUT, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { skipped++; done++; return; }
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Referer: 'https://nailmania.md/' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0) throw new Error('empty');
    fs.writeFileSync(dest, buf);
    downloaded++;
  } catch (e) {
    failed++; failures.push({ url: u, error: String(e.message || e) });
  }
  done++;
  if (done % 50 === 0 || done === urls.length)
    process.stdout.write(`\r  ${done}/${urls.length}  (new ${downloaded}, skip ${skipped}, fail ${failed})   `);
}

async function run() {
  let idx = 0;
  const worker = async () => { while (idx < urls.length) { const i = idx++; await getOne(urls[i]); } };
  await Promise.all(Array.from({ length: CONC }, worker));
  process.stdout.write('\n');

  // write mappings
  const mapping = products.map((p) => ({ ...p, files: p.urls.map(fileOf) }));
  fs.writeFileSync(MAP_JSON, JSON.stringify(mapping, null, 2));
  const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const csvOut = ['SKU,Brand,Category,Title,Files,Urls']
    .concat(mapping.map((p) => [p.sku, p.brand, p.category, p.title, p.files.join(' '), p.urls.join(' ')].map(esc).join(',')))
    .join('\n');
  fs.writeFileSync(MAP_CSV, csvOut);
  if (failures.length) fs.writeFileSync(path.join(__dirname, 'tilda-photos.failures.json'), JSON.stringify(failures, null, 2));

  console.log(`\nDone. new=${downloaded} skipped=${skipped} failed=${failed}`);
  console.log(`Images  -> public/images/tilda/`);
  console.log(`Mapping -> scripts/tilda-photos.json , tilda-photos.csv`);
  if (failures.length) console.log(`Failures-> scripts/tilda-photos.failures.json (${failures.length})`);
}
run();
