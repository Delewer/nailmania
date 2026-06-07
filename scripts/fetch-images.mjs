/* Fetch product photos by name via DuckDuckGo image search.
 *
 * Resumable: skips any SKU that already has a file in public/images/products/.
 * Safe: SafeSearch on, junk/fan-art/social domains blocked, size + aspect filtered.
 *
 * Usage:
 *   node scripts/fetch-images.mjs                 # all products
 *   node scripts/fetch-images.mjs --limit 10      # first 10 missing
 *   node scripts/fetch-images.mjs --concurrency 3 # parallel workers (default 3)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'images', 'products');
const LOG = path.join(__dirname, 'fetch-images.report.json');
fs.mkdirSync(OUT, { recursive: true });

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const LIMIT = parseInt(arg('--limit', '0'), 10) || Infinity;
const CONC = parseInt(arg('--concurrency', '3'), 10);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const H = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9,ro;q=0.8,ru;q=0.7' };

// domains that produce off-topic / fan-art / non-product / unstable results
const BLOCK = [
  'deviantart', 'wixmp.com', 'pinterest', 'pinimg.com', 'fbcdn', 'fbsbx',
  'lookaside', 'redd.it', 'reddit', 'tiktok', 'youtube', 'ytimg',
  'wallpaper', 'fanpop', 'artstation', 'tumblr', 'gettyimages', 'shutterstock',
  'alamy', 'dreamstime', 'istockphoto', '123rf',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.floor(Math.random() * (b - a));

const safeName = (k) => String(k).replace(/[^A-Za-z0-9._-]/g, '_');

function alreadyHave(key) {
  const base = safeName(key);
  return fs.existsSync(path.join(OUT, base + '.jpg'));
}

async function getVqd(q) {
  const r = await fetch('https://duckduckgo.com/?q=' + encodeURIComponent(q) + '&iax=images&ia=images', { headers: H });
  const t = await r.text();
  const m = t.match(/vqd=([\d-]+)/) || t.match(/vqd="([^"]+)"/) || t.match(/vqd='([^']+)'/);
  return m ? m[1] : null;
}

async function searchImages(q) {
  const vqd = await getVqd(q);
  if (!vqd) return [];
  await sleep(jitter(150, 350));
  const u = 'https://duckduckgo.com/i.js?l=us-en&o=json&q=' + encodeURIComponent(q) + '&vqd=' + vqd + '&f=,,,,,&p=1';
  const r = await fetch(u, { headers: { ...H, Referer: 'https://duckduckgo.com/' } });
  if (r.status !== 200) return [];
  const j = await r.json().catch(() => ({}));
  return j.results || [];
}

// order candidates: decent size, near-square first, jpg before webp/png, drop blocked domains
function rank(results) {
  return results
    .filter((x) => x.image && x.width >= 300 && x.height >= 300)
    .filter((x) => !BLOCK.some((b) => (x.image + ' ' + (x.source || '') + ' ' + (x.url || '')).toLowerCase().includes(b)))
    .map((x) => {
      const ar = x.width / x.height;
      const squareness = Math.abs(Math.log(ar)); // 0 = perfect square
      const isJpg = /\.jpe?g(\?|$)/i.test(x.image) ? 0 : 1;
      return { url: x.image, score: squareness * 2 + isJpg };
    })
    .sort((a, b) => a.score - b.score)
    .map((x) => x.url);
}

function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

async function download(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { ...H, Referer: 'https://duckduckgo.com/' }, signal: ctrl.signal });
    if (r.status !== 200) return null;
    const len = +r.headers.get('content-length') || 0;
    if (len > 6_000_000) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1500) return null; // too small to be a real photo
    return sniff(buf) ? buf : null;
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

// nail/beauty domain anchors per category — used to keep generic, no-brand
// names (e.g. "Aspirator 001A") from drifting to unrelated products.
const CTX = {
  gellac: 'gel lac unghii', baze: 'baza unghii', topuri: 'top unghii', alungire: 'unghii gel',
  solutii: 'manichiura', bituri: 'freza unghii', instrumente: 'manichiura', lichide: 'manichiura',
  sterilizare: 'sterilizare manichiura', epilare: 'epilare', pedichiura: 'pedichiura',
  tehnica: 'aparat manichiura', accesuare: 'manichiura', sprancene: 'sprancene',
  gene: 'extensii gene', ingrijire: 'ingrijire unghii', materiale: 'manichiura',
  design: 'decor unghii', slidiz: 'slider unghii',
};

function buildQuery(p) {
  const noBrand = !p.brand || /fără brand|fara brand/i.test(p.brand);
  if (!noBrand) return (p.brand + ' ' + p.name).replace(/\s+/g, ' ').trim();
  // no brand → append a category anchor so the search stays in the nail domain
  const ctx = CTX[p.cat] ? ' ' + CTX[p.cat] : ' manichiura';
  return (p.name + ctx).replace(/\s+/g, ' ').trim();
}

async function processOne(p) {
  const key = p.code || p.key || p.id;
  const q = buildQuery(p);
  let results;
  try {
    results = await searchImages(q);
  } catch {
    return { key, q, status: 'search-error' };
  }
  const cands = rank(results).slice(0, 6);
  if (!cands.length) return { key, q, status: 'no-results' };
  for (const url of cands) {
    const buf = await download(url);
    if (buf) {
      fs.writeFileSync(path.join(OUT, safeName(key) + '.jpg'), buf);
      return { key, q, status: 'ok', url };
    }
    await sleep(jitter(120, 260));
  }
  return { key, q, status: 'all-failed' };
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'catalog.json'), 'utf8'));
  const todo = catalog
    .filter((p) => !p.image) // already has a supplier URL
    .filter((p) => !alreadyHave(p.code || p.key || p.id))
    .slice(0, LIMIT);

  console.log(`Catalog: ${catalog.length} | already have/skipped: ${catalog.length - todo.length} | to fetch: ${todo.length} | concurrency: ${CONC}`);

  const report = { started: new Date().toISOString(), ok: 0, fail: 0, items: [] };
  let idx = 0, done = 0;

  async function worker() {
    while (idx < todo.length) {
      const p = todo[idx++];
      const res = await processOne(p);
      done++;
      if (res.status === 'ok') report.ok++; else report.fail++;
      report.items.push(res);
      if (done % 10 === 0 || done === todo.length) {
        console.log(`[${done}/${todo.length}] ok=${report.ok} fail=${report.fail}  last: ${res.status} ${res.key} "${res.q}"`);
        fs.writeFileSync(LOG, JSON.stringify(report, null, 2));
      }
      await sleep(jitter(300, 700));
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, CONC) }, worker));
  report.finished = new Date().toISOString();
  fs.writeFileSync(LOG, JSON.stringify(report, null, 2));
  console.log(`\nDONE. ok=${report.ok} fail=${report.fail}  report: ${path.relative(ROOT, LOG)}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
