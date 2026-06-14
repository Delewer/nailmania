/* Move the remaining Google-Drive photos in photos.csv onto R2, so nothing
 * depends on an external host. Downloads each Drive image, uploads it to the
 * bucket under drive/<id>.<ext>, and rewrites photos.csv to the R2 URL.
 *
 * Creds via env (or .env): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 * Usage: node scripts/migrate-drive-r2.mjs <public-base-url>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CSV = path.join(ROOT, 'photos.csv');
const BASE = (process.argv[2] || '').replace(/\/+$/, '');
if (!BASE) { console.error('Usage: node scripts/migrate-drive-r2.mjs <public-base-url>'); process.exit(1); }

try { for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) { console.error('Missing R2 creds'); process.exit(1); }
const s3 = new S3Client({ region: 'auto', endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY } });

function parse(t){const R=[];let r=[],f="",q=false;t=t.replace(/^﻿/,"");for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c=='"'){if(t[i+1]=='"'){f+='"';i++;}else q=false;}else f+=c;}else if(c=='"')q=true;else if(c==','){r.push(f);f="";}else if(c=='\n'){r.push(f);R.push(r);r=[];f="";}else if(c!='\r')f+=c;}if(f.length||r.length){r.push(f);R.push(r);}return R;}
const qt = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const isDrive = (u) => /googleusercontent|drive\.google/.test(u);
const driveId = (u) => (u.match(/\/d\/([A-Za-z0-9_-]+)/) || [])[1] || u.replace(/\W+/g, '').slice(0, 16);
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

const rows = parse(fs.readFileSync(CSV, 'utf8'));
const h = rows[0].map((x) => x.toLowerCase().trim());
const si = h.indexOf('sku'), pi = h.indexOf('photo');

const urls = new Set();
for (const r of rows.slice(1)) for (const u of (r[pi] || '').split(/\s+/).filter(Boolean)) if (isDrive(u)) urls.add(u);
console.log(`unique Drive URLs: ${urls.size}`);

const remap = {};
for (const u of urls) {
  try {
    const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    const ext = EXT[ct] || 'jpg';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new Error('too small (' + buf.length + 'b)');
    const key = `drive/${driveId(u)}.${ext}`;
    await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buf, ContentType: ct || 'image/jpeg', CacheControl: 'public, max-age=31536000, immutable' }));
    remap[u] = `${BASE}/${key}`;
    console.log(`  ok ${u.slice(0, 60)}… -> ${key} (${buf.length}b)`);
  } catch (e) { console.log(`  FAIL ${u} : ${e.message}`); }
}

// rewrite photos.csv
let changed = 0;
const out = [['SKU', 'Photo']];
for (const r of rows.slice(1)) {
  const sku = (r[si] || '').trim(); if (!sku) continue;
  const photo = (r[pi] || '').split(/\s+/).filter(Boolean).map((u) => { if (remap[u]) { changed++; return remap[u]; } return u; }).join(' ');
  out.push([sku, photo]);
}
fs.writeFileSync(CSV, '﻿' + out.map((r) => r.map(qt).join(',')).join('\n') + '\n');
console.log(`migrated ${Object.keys(remap).length}/${urls.size} URLs, rewrote ${changed} tokens in photos.csv`);
