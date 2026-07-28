/* Re-host external catalog image URLs into Cloudflare R2.
 *
 * The tracked image policy first canonicalizes known URLs from the same bucket,
 * then applies the durable exact external URL map. Only genuinely external,
 * still-unmapped URLs are downloaded and uploaded. A fully successful batch
 * atomically extends that map and rewrites the generated catalog. Any transfer
 * failure leaves both tracked files untouched.
 *
 * Creds via env or .env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY, R2_BUCKET.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import {
  catalogImagePolicyFromConfig,
} from './catalog-image-policy.mjs';
import {
  assertProductionRehostTarget,
  rehostCatalogImages,
} from './rehost-images-core.mjs';
import { requirePublicBaseUrl, requireR2MutationTarget } from './r2-target-guard.mjs';
import {
  fetchPublicImage,
  sniffSupportedImage,
} from './safe-external-image-fetch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'src', 'catalog.json');
const cliArgs = process.argv.slice(2);
const environmentIndex = cliArgs.indexOf('--environment');
const requestedEnvironment = environmentIndex >= 0 ? String(cliArgs[environmentIndex + 1] || '') : '';
if (requestedEnvironment !== 'production') {
  throw new Error('rehost-images is production-only; --environment production is required');
}

// Load .env (KEY=VALUE per line).
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  throw new Error('rehost-images: missing R2 credentials; refusing to leave external URLs silently');
}

const target = requireR2MutationTarget({ root: ROOT, args: cliArgs });
const publicBaseUrl = requirePublicBaseUrl(cliArgs, process.env, target.environment);
const catalogConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.config.json'), 'utf8'));
const imagePolicy = catalogImagePolicyFromConfig(catalogConfig, ROOT);
assertProductionRehostTarget({ target, publicBaseUrl, policy: imagePolicy });

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

async function download(url) {
  const host = new URL(url).host;
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const headerSets = [
    {
      'User-Agent': userAgent,
      Accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8',
      Referer: `https://${host}/`,
    },
    { 'User-Agent': userAgent, Accept: 'image/*,*/*' },
  ];
  let lastError;
  for (const headers of headerSets) {
    try {
      const response = await fetchPublicImage(url, {
        headers,
      });
      const buffer = response.buffer;
      const kind = sniffSupportedImage(buffer);
      if (kind && buffer.length >= 1024) return { buffer, ...kind };
      lastError = new Error('response was not a supported image or was smaller than 1024 bytes');
    } catch (error) {
      lastError = error;
      // Try the next conservative browser-header variant.
    }
  }
  throw new Error(`download failed: ${lastError?.message || 'unsupported response'}`);
}

async function r2Exists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (error) {
    const status = Number(error?.$metadata?.httpStatusCode || 0);
    if (status === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') return false;
    throw error;
  }
}

async function transfer(url) {
  const image = await download(url);
  const key = `${crypto.createHash('sha256').update(image.buffer).digest('hex')}.${image.ext}`;
  if (!(await r2Exists(key))) {
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: image.buffer,
      ContentType: image.contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }));
  }
  return `${publicBaseUrl}/${key}`;
}

let progressWasPrinted = false;
const result = await rehostCatalogImages({
  catalogPath: CATALOG,
  policy: imagePolicy,
  transfer,
  concurrency: 6,
  onProgress: ({ completed, total, successful, failed }) => {
    progressWasPrinted = true;
    process.stdout.write(`\r  ${completed}/${total}  ok=${successful} fail=${failed}   `);
  },
});
if (progressWasPrinted) process.stdout.write('\n');

if (result.externalCount === 0) {
  console.log(
    `rehost-images: no unmapped external image URLs; catalogChanged=${result.catalogChanged}`,
  );
} else {
  console.log(
    `rehost-images: rehosted=${result.rehostedCount} failed=${result.failures.length} `
      + `mapChanged=${result.mapChanged} catalogChanged=${result.catalogChanged}`,
  );
}

if (!result.ok) {
  console.error('  catalog and tracked URL map were not rewritten because the batch was incomplete.');
  console.error('  could not transfer (left as-is):');
  for (const failure of result.failures) {
    console.error(`   ${failure.url} (${failure.error})`);
  }
  process.exitCode = 1;
}
