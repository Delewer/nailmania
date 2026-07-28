import {
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function parseHttpUrl(value, label) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label} must be an absolute HTTP(S) URL without credentials`);
  }
  return url;
}

function configuredOrigin(value, label) {
  const url = parseHttpUrl(value, label);
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must be an origin without a path, query, or fragment`);
  }
  return url.origin;
}

function configuredBaseUrl(value) {
  const url = parseHttpUrl(value, 'imagePolicy.canonicalBaseUrl');
  if (url.protocol !== 'https:' || url.search || url.hash) {
    throw new Error('imagePolicy.canonicalBaseUrl must be an HTTPS origin/path without query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

function trackedPath(root, value) {
  const relative = String(value || '').trim();
  if (!relative || path.isAbsolute(relative)) {
    throw new Error('imagePolicy.externalUrlMapFile must be a tracked path relative to the repository root');
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const fromRoot = path.relative(resolvedRoot, resolved);
  if (!fromRoot || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
    throw new Error('imagePolicy.externalUrlMapFile must stay inside the repository root');
  }
  return resolved;
}

export function catalogImagePolicyFromConfig(config, root) {
  const raw = config?.imagePolicy;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('catalog.config.json must define imagePolicy');
  }
  const canonicalBaseUrl = configuredBaseUrl(raw.canonicalBaseUrl);
  const productionBucket = String(raw.productionBucket || '').trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(productionBucket)) {
    throw new Error('imagePolicy.productionBucket must be an exact R2 bucket name');
  }
  const legacyValues = raw.legacySameBucketOrigins;
  if (!Array.isArray(legacyValues) || legacyValues.length === 0) {
    throw new Error('imagePolicy.legacySameBucketOrigins must contain at least one origin');
  }
  const legacySameBucketOrigins = [...new Set(legacyValues.map(
    (value, index) => configuredOrigin(value, `imagePolicy.legacySameBucketOrigins[${index}]`),
  ))];
  const canonicalOrigin = new URL(canonicalBaseUrl).origin;
  if (legacySameBucketOrigins.includes(canonicalOrigin)) {
    throw new Error('imagePolicy legacy and canonical origins must be different');
  }
  return Object.freeze({
    canonicalBaseUrl,
    canonicalOrigin,
    productionBucket,
    legacySameBucketOrigins: Object.freeze(legacySameBucketOrigins),
    externalUrlMapPath: trackedPath(root, raw.externalUrlMapFile),
  });
}

function suffixAfterUrlAuthority(raw) {
  const schemeEnd = raw.indexOf('://');
  if (schemeEnd < 0) return '';
  const authorityStart = schemeEnd + 3;
  const suffixOffset = raw.slice(authorityStart).search(/[/?#]/);
  return suffixOffset < 0 ? '' : raw.slice(authorityStart + suffixOffset);
}

export function canonicalizeKnownSameBucketUrl(value, policy) {
  const raw = String(value || '');
  const queryOrFragment = raw.search(/[?#]/);
  const pathAndAuthority = queryOrFragment < 0 ? raw : raw.slice(0, queryOrFragment);
  const tail = queryOrFragment < 0 ? '' : raw.slice(queryOrFragment);
  // WHATWG treats backslashes as path separators for HTTP(S). Normalize them
  // before extracting the authority suffix so a valid legacy URL can never
  // silently collapse to the canonical origin root.
  const normalizedRaw = `${pathAndAuthority.replaceAll('\\', '/')}${tail}`;
  let url;
  try {
    url = new URL(normalizedRaw);
  } catch {
    return raw;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return raw;
  return policy.legacySameBucketOrigins.includes(url.origin)
    ? `${policy.canonicalBaseUrl}${suffixAfterUrlAuthority(normalizedRaw)}`
    : raw;
}

export function isCanonicalImageUrl(value, policy) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== policy.canonicalOrigin) {
    return false;
  }
  const basePath = new URL(`${policy.canonicalBaseUrl}/`).pathname.replace(/\/+$/, '');
  return !basePath || url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
}

export function isExternalImageUrl(value, policy) {
  const canonicalized = canonicalizeKnownSameBucketUrl(value, policy);
  try {
    const url = new URL(canonicalized);
    return ['http:', 'https:'].includes(url.protocol) && !isCanonicalImageUrl(canonicalized, policy);
  } catch {
    return false;
  }
}

export function validateExternalImageUrlMap(value, policy) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The external image URL map must be a JSON object');
  }
  const validated = {};
  for (const [source, destination] of Object.entries(value)) {
    parseHttpUrl(source, `External image map source ${JSON.stringify(source)}`);
    if (!isExternalImageUrl(source, policy)) {
      throw new Error(`External image map source is not external: ${source}`);
    }
    parseHttpUrl(destination, `External image map destination for ${JSON.stringify(source)}`);
    if (!isCanonicalImageUrl(destination, policy)) {
      throw new Error(`External image map destination is outside ${policy.canonicalBaseUrl}: ${destination}`);
    }
    validated[source] = destination;
  }
  return validated;
}

export function readExternalImageUrlMap(policy) {
  return readExternalImageUrlMapSnapshot(policy).map;
}

export function readExternalImageUrlMapSnapshot(policy) {
  let text;
  let parsed;
  try {
    text = readFileSync(policy.externalUrlMapPath, 'utf8');
    parsed = JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Tracked external image URL map is missing: ${policy.externalUrlMapPath}`);
    }
    throw error;
  }
  return {
    text,
    map: validateExternalImageUrlMap(parsed, policy),
  };
}

export function rewriteImageUrl(value, policy, externalUrlMap = {}) {
  const raw = String(value || '');
  const mapped = own(externalUrlMap, raw) ? externalUrlMap[raw] : raw;
  return canonicalizeKnownSameBucketUrl(mapped, policy);
}

export function rewriteImageValue(value, policy, externalUrlMap = {}) {
  const tokens = String(value || '').trim().split(/\s+/).filter(Boolean);
  return tokens.map((url) => rewriteImageUrl(url, policy, externalUrlMap)).join(' ');
}

export function rewriteCatalogImages(catalog, policy, externalUrlMap = {}) {
  return catalog.map((product) => {
    if (!product?.image) return product;
    const image = rewriteImageValue(product.image, policy, externalUrlMap);
    return image === product.image ? product : { ...product, image };
  });
}

export function collectExternalImageUrls(catalog, policy) {
  const urls = new Set();
  for (const product of catalog) {
    if (!product?.image) continue;
    for (const value of String(product.image).trim().split(/\s+/)) {
      if (isExternalImageUrl(value, policy)) urls.add(value);
    }
  }
  return [...urls];
}

export function sortedExternalImageUrlMap(value, policy) {
  const validated = validateExternalImageUrlMap(value, policy);
  return Object.fromEntries(Object.entries(validated).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  )));
}

export function assertFileTextUnchanged(filePath, expectedText, label = path.basename(filePath)) {
  let actualText;
  try {
    actualText = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Stale tracked image state: ${label} was removed during the operation`);
    }
    throw error;
  }
  if (actualText !== expectedText) {
    throw new Error(`Stale tracked image state: ${label} changed during the operation`);
  }
}

export function atomicWriteText(filePath, text, { expectedText } = {}) {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' });
    if (expectedText !== undefined) {
      assertFileTextUnchanged(filePath, expectedText);
    }
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeExternalImageUrlMapAtomic(policy, value, { expectedText } = {}) {
  const sorted = sortedExternalImageUrlMap(value, policy);
  atomicWriteText(
    policy.externalUrlMapPath,
    `${JSON.stringify(sorted, null, 2)}\n`,
    { expectedText },
  );
  return sorted;
}

export function canonicalCatalogImageIssues(catalog, policy) {
  if (!Array.isArray(catalog)) {
    throw new Error('Release catalog must be a JSON array');
  }
  const issues = [];
  for (const product of catalog) {
    if (!product?.image) continue;
    for (const url of String(product.image).trim().split(/\s+/).filter(Boolean)) {
      if (!isCanonicalImageUrl(url, policy)) {
        issues.push({
          key: String(product.key || ''),
          url,
        });
      }
    }
  }
  return issues;
}

export function assertCanonicalCatalogImagesForRelease(root) {
  const config = JSON.parse(readFileSync(path.join(root, 'catalog.config.json'), 'utf8'));
  const policy = catalogImagePolicyFromConfig(config, root);
  // A release must be reproducible from the same tracked exact map, even if the
  // current catalog happens to contain only canonical URLs.
  readExternalImageUrlMap(policy);
  const catalog = JSON.parse(readFileSync(path.join(root, 'src', 'catalog.json'), 'utf8'));
  const issues = canonicalCatalogImageIssues(catalog, policy);
  if (issues.length) {
    const sample = issues.slice(0, 5)
      .map((issue) => `${issue.key || '<unknown>'}: ${issue.url}`)
      .join('\n  ');
    throw new Error(
      `Release catalog contains ${issues.length} non-canonical image URL(s); `
        + `complete production rehost first:\n  ${sample}`,
    );
  }
  return {
    products: catalog.length,
    images: catalog.reduce(
      (count, product) => count + String(product?.image || '').trim().split(/\s+/).filter(Boolean).length,
      0,
    ),
    canonicalBaseUrl: policy.canonicalBaseUrl,
    productionBucket: policy.productionBucket,
  };
}
