/* Re-host any external image URLs into Cloudflare R2 so the storefront never
 * depends on a third-party host.
 *
 * Runs AFTER `npm run catalog` (see the "prebuild" script). It scans the
 * generated src/catalog.json for image URLs that are NOT already on R2, then for
 * each one: downloads it (browser headers, beats hotlink protection), verifies
 * it's a real image (magic bytes, not an HTML error page), uploads it to the
 * bucket as <md5>.<ext> (content hash => dedupes + idempotent), and rewrites the
 * URL in the generated src/catalog.json (the artifact that ships).
 *
 * This is what makes the client's "paste an image URL in the sheet's Foto column"
 * workflow safe: whatever they paste ends up served from our own R2.
 *
 * Creds via env or .env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 * No creds? -> logs a warning and exits 0 (build still succeeds; URLs ship as-is).
 *
 * Run: node scripts/rehost-images.mjs   (or just `npm run rehost`)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'src', 'catalog.json');
const PUB = 'https://pub-bdc9e7e148164007b19e2753ba1b49b9.r2.dev/';

// load .env (KEY=VALUE per line)
try {
  for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.warn('rehost-images: no R2 credentials — skipping (external image URLs, if any, ship as-is).');
  process.exit(0);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

const isExternal = (u) => { try { const h = new URL(u).host; return !h.endsWith('r2.dev') && !h.includes('tildacdn'); } catch { return false; } };

function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { ext: 'jpg', ct: 'image/jpeg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return { ext: 'png', ct: 'image/png' };
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', ct: 'image/webp' };
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return { ext: 'gif', ct: 'image/gif' };
  return null;
}

async function download(u) {
  const host = new URL(u).host;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const headerSets = [
    { 'User-Agent': UA, 'Accept': 'image/avif,image/webp,image/png,image/*,*/*;q=0.8', 'Referer': `https://${host}/` },
    { 'User-Agent': UA, 'Accept': 'image/*,*/*' },
  ];
  for (const headers of headerSets) {
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 30000);
      const r = await fetch(u, { headers, redirect: 'follow', signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      const kind = sniff(buf);
      if (!kind || buf.length < 1024) continue;   // not a real image / too small (HTML error page etc.)
      return { buf, ...kind };
    } catch { /* try next */ }
  }
  return null;
}

async function r2exists(key) { try { await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key })); return true; } catch { return false; } }

// ---- collect external URLs from the generated catalog ----
const catalogText = fs.readFileSync(CATALOG, 'utf8');
const catalog = JSON.parse(catalogText);
const urls = new Set();
for (const p of catalog) {
  if (!p.image) continue;
  for (const u of String(p.image).trim().split(/\s+/)) if (/^https?:\/\//.test(u) && isExternal(u)) urls.add(u);
}
const list = [...urls];
if (!list.length) { console.log('rehost-images: no external image URLs — nothing to do.'); process.exit(0); }
console.log(`rehost-images: ${list.length} external URL(s) to move to R2…`);

const map = {};        // externalUrl -> r2 url
const failures = [];
let done = 0, idx = 0;
const CONC = 6;
async function worker() {
  while (idx < list.length) {
    const u = list[idx++];
    const got = await download(u);
    if (!got) { failures.push(u); }
    else {
      const key = `${crypto.createHash('md5').update(got.buf).digest('hex')}.${got.ext}`;
      try {
        if (!(await r2exists(key))) {
          await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: got.buf, ContentType: got.ct, CacheControl: 'public, max-age=31536000, immutable' }));
        }
        map[u] = PUB + key;
      } catch (e) { failures.push(`${u} (upload: ${e.message || e})`); }
    }
    done++;
    process.stdout.write(`\r  ${done}/${list.length}  ok=${Object.keys(map).length} fail=${failures.length}   `);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
process.stdout.write('\n');

// ---- rewrite catalog.json (targeted replace, longest first) ----
const pairs = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
if (pairs.length) {
  let cat = catalogText;
  for (const [ext, r2u] of pairs) cat = cat.split(ext).join(r2u);
  fs.writeFileSync(CATALOG, cat);
}

console.log(`rehost-images: rehosted=${Object.keys(map).length} failed=${failures.length}`);
if (failures.length) { console.log('  could not fetch (left as-is):'); failures.forEach((f) => console.log('   ' + f)); }
