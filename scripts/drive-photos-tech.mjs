/* Match an equipment Drive folder (category → product → «Фото» → images, deep)
   to catalog products by MODEL CODE (ZS-606, BQ-858, MUSSON X3, XPS-400, SM-507…).
   Appends to photos.csv (keeps existing matches). Run: node scripts/drive-photos-tech.mjs [ROOT_ID] */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

const ROOT_ID = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '1dwK8cfh0e_hh3nEFQ9t5jledanVAx0lL';
const IMG = /\.(jpe?g|png|webp)$/i;
const CONTENT = new Set(['фото', 'reels', 'відеоогляд', 'відео', 'video', 'опис та характеристики', 'опис', 'характеристики']);
const lh3 = (id) => `https://lh3.googleusercontent.com/d/${id}`;

// global fetch concurrency limiter
let active = 0; const waiters = [];
const gate = async () => { if (active >= 8) await new Promise((r) => waiters.push(r)); active++; };
const ungate = () => { active--; const w = waiters.shift(); if (w) w(); };
const list = async (id) => {
  await gate();
  try {
    const h = await (await fetch(`https://drive.google.com/embeddedfolderview?id=${id}#list`)).text();
    const re = /id="entry-([A-Za-z0-9_-]{20,})"[\s\S]*?flip-entry-title">([^<]+)/g;
    const o = []; let m; while ((m = re.exec(h))) o.push({ id: m[1], name: m[2].trim() });
    return o;
  } finally { ungate(); }
};

// deep crawl → one photo per product folder
const products = []; // {product, img}
const isContent = (n) => CONTENT.has(n.toLowerCase().trim());
async function crawl(node, depth) {
  const items = await list(node.id);
  const imgs = items.filter((e) => IMG.test(e.name));
  if (imgs.length) {
    const jpg = imgs.find((e) => /\.jpe?g$/i.test(e.name)) || imgs[0];
    products.push({ product: isContent(node.name) ? node.parent : node.name, img: jpg.id });
  }
  if (depth < 5) {
    const subs = items.filter((e) => !/\.\w{2,4}$/.test(e.name)).map((s) => ({ id: s.id, name: s.name, parent: node.name }));
    await Promise.all(subs.map((s) => crawl(s, depth + 1)));
  }
}
await crawl({ id: ROOT_ID, name: 'ROOT', parent: '' }, 0);
console.log(`Crawled product folders with photos: ${products.length}`);

// model-code tokens
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ''); // Latin + digits only
const tokens = (name) => {
  const t = new Set();
  for (const m of name.match(/[A-Za-z]{2,6}-?\d{2,4}[A-Za-z]?(?:-\d+)?/g) || []) t.add(norm(m));
  for (const m of name.match(/(?:musson|sun|krypton|champion|strong|marathon)\s*x?\s*-?\s*\d+[a-z]?/gi) || []) t.add(norm(m));
  return [...t].filter((x) => x.length >= 4);
};
const driveSig = products.map((d) => ({ ...d, sig: norm(d.product) }));
// a model token matches only if it is NOT immediately followed by another digit
// (so "sun4" won't hit "48W", "sunx5" won't hit "54W", "musson x3" still hits "x3 … 72вт")
const matchAt = (sig, tok) => {
  let i = sig.indexOf(tok);
  while (i >= 0) { const after = sig[i + tok.length]; if (!after || !/\d/.test(after)) return true; i = sig.indexOf(tok, i + 1); }
  return false;
};
// try real products before spare parts / accessories
const isAccessory = (n) => /ручка|філ|фил|змінн|смінн|діод|diod|led\+|блок живлен|кабел|адаптер|насадк|ковпач|основ|сумк|підставк/i.test(n);
const ordered = [...driveSig.filter((d) => !isAccessory(d.product)), ...driveSig.filter((d) => isAccessory(d.product))];

// existing photos.csv → keep
const csvPath = path.join(process.cwd(), 'photos.csv');
const map = {};
if (existsSync(csvPath)) {
  for (const line of readFileSync(csvPath, 'utf8').split(/\r?\n/).slice(1)) {
    const m = line.match(/^"?([^",]+)"?,"?([^"]+)"?$/);
    if (m) map[m[1]] = m[2];
  }
}
const before = Object.keys(map).length;

const catalog = JSON.parse(readFileSync(path.join(process.cwd(), 'src', 'catalog.json'), 'utf8'));
const matched = [];
for (const p of catalog) {
  const sku = p.code || p.key;
  if (map[sku]) continue;
  const ts = tokens(p.name);
  if (!ts.length) continue;
  const hit = ordered.find((d) => ts.some((t) => matchAt(d.sig, t)));
  if (hit) { map[sku] = lh3(hit.img); matched.push([sku, p.name, hit.product]); }
}

writeFileSync(csvPath, '﻿SKU,Photo\r\n' + Object.entries(map).map(([s, u]) => `"${s}","${u}"`).join('\r\n') + '\r\n');
console.log(`Equipment matched: ${matched.length} (photos.csv ${before} → ${Object.keys(map).length})\n`);
for (const [sku, cat, drv] of matched) console.log(`  ${sku.padEnd(7)} ${cat.slice(0, 40).padEnd(40)} ← ${drv}`);
