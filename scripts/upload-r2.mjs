/* Upload product photos to a Cloudflare R2 bucket (S3-compatible).
 *
 * Prereq:  npm i -D @aws-sdk/client-s3
 * Creds (env or a .env file in project root):
 *   R2_ACCOUNT_ID        = your Cloudflare account id
 *   R2_ACCESS_KEY_ID     = R2 API token access key
 *   R2_SECRET_ACCESS_KEY = R2 API token secret
 *   R2_BUCKET            = bucket name (e.g. nailmania-photos)
 *
 * Usage:
 *   node scripts/upload-r2.mjs                      # upload public/images/tilda
 *   node scripts/upload-r2.mjs <dir> --prefix img   # custom source dir / key prefix
 *
 * Resumable: skips objects already present in the bucket.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// load a simple .env if present (KEY=VALUE per line)
try {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
} catch {}

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.error('Missing R2 credentials. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (env or .env).');
  process.exit(1);
}

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SRC = (process.argv[2] && !process.argv[2].startsWith('--')) ? path.resolve(process.argv[2]) : path.join(ROOT, 'public', 'images', 'tilda');
const PREFIX = (arg('--prefix', '') || '').replace(/^\/|\/$/g, '');
const key = (name) => (PREFIX ? PREFIX + '/' : '') + name;

const CT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

const files = fs.readdirSync(SRC).filter((f) => CT[path.extname(f).toLowerCase()]);
console.log(`Source : ${SRC}\nBucket : ${R2_BUCKET}${PREFIX ? ' /' + PREFIX : ''}\nFiles  : ${files.length}\n`);

let done = 0, up = 0, skip = 0, fail = 0;
const failures = [];

async function exists(k) {
  try { await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: k })); return true; }
  catch { return false; }
}
async function one(name) {
  const k = key(name);
  try {
    if (await exists(k)) { skip++; }
    else {
      await s3.send(new PutObjectCommand({
        Bucket: R2_BUCKET, Key: k,
        Body: fs.readFileSync(path.join(SRC, name)),
        ContentType: CT[path.extname(name).toLowerCase()],
        CacheControl: 'public, max-age=31536000, immutable',
      }));
      up++;
    }
  } catch (e) { fail++; failures.push({ name, error: String(e.message || e) }); }
  done++;
  if (done % 25 === 0 || done === files.length) process.stdout.write(`\r  ${done}/${files.length}  (up ${up}, skip ${skip}, fail ${fail})   `);
}

const CONC = parseInt(arg('--concurrency', '16'), 10);
let idx = 0;
const worker = async () => { while (idx < files.length) await one(files[idx++]); };
await Promise.all(Array.from({ length: CONC }, worker));
process.stdout.write('\n');
if (failures.length) { fs.writeFileSync(path.join(__dirname, 'upload-r2.failures.json'), JSON.stringify(failures, null, 2)); console.log(`failures -> scripts/upload-r2.failures.json (${failures.length})`); }
console.log(`Done. uploaded=${up} skipped=${skip} failed=${fail}`);
