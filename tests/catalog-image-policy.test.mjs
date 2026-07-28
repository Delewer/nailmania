import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  canonicalizeKnownSameBucketUrl,
  canonicalCatalogImageIssues,
  catalogImagePolicyFromConfig,
  isExternalImageUrl,
  rewriteImageValue,
  sortedExternalImageUrlMap,
} from '../scripts/catalog-image-policy.mjs';
import { validateCatalogSheetText } from '../scripts/catalog-integrity.mjs';
import {
  assertProductionRehostTarget,
  rehostCatalogImages,
} from '../scripts/rehost-images-core.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'));
const BUILDER = path.join(ROOT, 'scripts', 'build-catalog.mjs');
const REHOST = path.join(ROOT, 'scripts', 'rehost-images.mjs');
const LEGACY_ORIGIN = 'https://pub-bdc9e7e148164007b19e2753ba1b49b9.r2.dev';
const CANONICAL_BASE = 'https://images.nailmania.md';
const REQUIRED_HEADER = 'Brand,SKU,Category,Title,Text,Quantity,Price,Price Old,Sale,New,Promo,Foto';

function imageConfig() {
  return {
    sheetUrl: '',
    imagePolicy: {
      canonicalBaseUrl: CANONICAL_BASE,
      productionBucket: 'nailmania-photos',
      legacySameBucketOrigins: [LEGACY_ORIGIN],
      externalUrlMapFile: 'catalog-image-url-map.json',
    },
  };
}

function fixture(t, catalog, urlMap = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'nailmania-image-policy-'));
  mkdirSync(path.join(directory, 'src'));
  writeFileSync(path.join(directory, 'catalog.config.json'), `${JSON.stringify(imageConfig())}\n`);
  writeFileSync(path.join(directory, 'catalog-image-url-map.json'), `${JSON.stringify(urlMap, null, 2)}\n`);
  writeFileSync(path.join(directory, 'src', 'catalog.json'), `${JSON.stringify(catalog)}\n`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    catalogPath: path.join(directory, 'src', 'catalog.json'),
    mapPath: path.join(directory, 'catalog-image-url-map.json'),
    policy: catalogImagePolicyFromConfig(imageConfig(), directory),
  };
}

test('same-bucket canonicalization matches only the configured origin and preserves path and query', () => {
  const directory = path.join(tmpdir(), 'nailmania-image-policy-config');
  const policy = catalogImagePolicyFromConfig(imageConfig(), directory);
  const legacy = `${LEGACY_ORIGIN}/folder/../My%20Photo.webp?width=900&format=webp#primary`;
  const lookalike = `${LEGACY_ORIGIN}.attacker.example/folder/photo.webp?width=900`;

  assert.equal(
    canonicalizeKnownSameBucketUrl(legacy, policy),
    `${CANONICAL_BASE}/folder/../My%20Photo.webp?width=900&format=webp#primary`,
  );
  assert.equal(canonicalizeKnownSameBucketUrl(lookalike, policy), lookalike);
  assert.equal(isExternalImageUrl(legacy, policy), false);
  assert.equal(isExternalImageUrl(lookalike, policy), true);
});

test('same-bucket canonicalization normalizes WHATWG backslash paths without collapsing them', () => {
  const directory = path.join(tmpdir(), 'nailmania-image-policy-config');
  const policy = catalogImagePolicyFromConfig(imageConfig(), directory);
  const legacy = `${LEGACY_ORIGIN}\\backup\\nested\\photo.webp?transform=a\\b#main`;

  assert.equal(
    canonicalizeKnownSameBucketUrl(legacy, policy),
    `${CANONICAL_BASE}/backup/nested/photo.webp?transform=a\\b#main`,
  );
});

test('the tracked external URL map is exact and does not rewrite URL variants', () => {
  const directory = path.join(tmpdir(), 'nailmania-image-policy-config');
  const policy = catalogImagePolicyFromConfig(imageConfig(), directory);
  const source = 'https://supplier.example/photo.jpg?version=1';
  const variant = 'https://supplier.example/photo.jpg?version=10';
  const destination = `${CANONICAL_BASE}/sha256.jpg`;

  assert.equal(
    rewriteImageValue(`${source} ${variant}`, policy, { [source]: destination }),
    `${destination} ${variant}`,
  );
});

test('external URL map sorting is deterministic code-unit order, independent of locale', () => {
  const directory = path.join(tmpdir(), 'nailmania-image-policy-config');
  const policy = catalogImagePolicyFromConfig(imageConfig(), directory);
  const map = {
    'https://supplier.example/z.jpg': `${CANONICAL_BASE}/z.jpg`,
    'https://supplier.example/A.jpg': `${CANONICAL_BASE}/a.jpg`,
    'https://supplier.example/a.jpg': `${CANONICAL_BASE}/lower-a.jpg`,
  };

  assert.deepEqual(Object.keys(sortedExternalImageUrlMap(map, policy)), [
    'https://supplier.example/A.jpg',
    'https://supplier.example/a.jpg',
    'https://supplier.example/z.jpg',
  ]);
});

test('rehost target is production-only and exact-host/exact-bucket bound', () => {
  const directory = path.join(tmpdir(), 'nailmania-image-policy-config');
  const policy = catalogImagePolicyFromConfig(imageConfig(), directory);
  const exact = {
    target: { environment: 'production', bucket: 'nailmania-photos' },
    publicBaseUrl: CANONICAL_BASE,
    policy,
  };
  assert.deepEqual(assertProductionRehostTarget(exact), {
    environment: 'production',
    bucket: 'nailmania-photos',
    publicBaseUrl: CANONICAL_BASE,
  });
  assert.throws(
    () => assertProductionRehostTarget({
      ...exact,
      target: { environment: 'preview', bucket: 'nailmania-product-images-preview' },
    }),
    /production-only/,
  );
  assert.throws(
    () => assertProductionRehostTarget({
      ...exact,
      target: { environment: 'production', bucket: 'wrong-bucket' },
    }),
    /exact production bucket/,
  );
  assert.throws(
    () => assertProductionRehostTarget({
      ...exact,
      publicBaseUrl: 'https://other-images.example',
    }),
    /exact production canonical host/,
  );
});

test('rehost CLI refuses preview before credentials, network, or R2 are considered', () => {
  const result = spawnSync(process.execPath, [
    REHOST,
    '--environment', 'preview',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /production-only/);
  assert.equal(result.stderr.includes('missing R2 credentials'), false);
});

test('rehost canonicalizes the known same-bucket origin before collecting external URLs', async (t) => {
  const legacy = `${LEGACY_ORIGIN}/backup/item.webp?version=7`;
  const alreadyMapped = 'https://supplier.example/already.jpg';
  const newExternal = 'https://supplier.example/new.jpg?size=large';
  const existingDestination = `${CANONICAL_BASE}/existing.webp`;
  const newDestination = `${CANONICAL_BASE}/new.webp`;
  const files = fixture(t, [
    { key: 'ONE', image: `${legacy} ${alreadyMapped} ${newExternal}` },
  ], {
    [alreadyMapped]: existingDestination,
  });
  const transferred = [];

  const result = await rehostCatalogImages({
    catalogPath: files.catalogPath,
    policy: files.policy,
    concurrency: 2,
    transfer: async (url) => {
      transferred.push(url);
      return newDestination;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.externalCount, 1);
  assert.deepEqual(transferred, [newExternal]);
  assert.equal(
    JSON.parse(readFileSync(files.catalogPath, 'utf8'))[0].image,
    `${CANONICAL_BASE}/backup/item.webp?version=7 ${existingDestination} ${newDestination}`,
  );
  assert.deepEqual(JSON.parse(readFileSync(files.mapPath, 'utf8')), {
    [alreadyMapped]: existingDestination,
    [newExternal]: newDestination,
  });
  assert.deepEqual(
    readdirSync(files.directory).filter((file) => file.endsWith('.tmp')),
    [],
  );
});

test('rehost leaves catalog and tracked map byte-for-byte unchanged on any batch failure', async (t) => {
  const legacy = `${LEGACY_ORIGIN}/backup/item.webp?version=7`;
  const first = 'https://supplier.example/first.jpg';
  const second = 'https://supplier.example/second.jpg';
  const files = fixture(t, [
    { key: 'ONE', image: `${legacy} ${first} ${second}` },
  ]);
  const originalCatalog = readFileSync(files.catalogPath, 'utf8');
  const originalMap = readFileSync(files.mapPath, 'utf8');

  const result = await rehostCatalogImages({
    catalogPath: files.catalogPath,
    policy: files.policy,
    concurrency: 1,
    transfer: async (url) => {
      if (url === second) throw new Error('simulated upload failure');
      return `${CANONICAL_BASE}/successful-but-uncommitted.jpg`;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.rehostedCount, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(readFileSync(files.catalogPath, 'utf8'), originalCatalog);
  assert.equal(readFileSync(files.mapPath, 'utf8'), originalMap);
  assert.deepEqual(
    readdirSync(files.directory).filter((file) => file.endsWith('.tmp')),
    [],
  );
});

test('rehost CAS refuses to overwrite a catalog changed during the transfer batch', async (t) => {
  const external = 'https://supplier.example/slow.jpg';
  const files = fixture(t, [
    { key: 'ONE', image: external },
  ]);
  const concurrentCatalog = `${JSON.stringify([
    { key: 'ONE', image: `${CANONICAL_BASE}/concurrent-edit.jpg` },
  ])}\n`;
  const originalMap = readFileSync(files.mapPath, 'utf8');

  await assert.rejects(
    rehostCatalogImages({
      catalogPath: files.catalogPath,
      policy: files.policy,
      concurrency: 1,
      transfer: async () => {
        writeFileSync(files.catalogPath, concurrentCatalog);
        return `${CANONICAL_BASE}/transferred.jpg`;
      },
    }),
    /Stale tracked image state: catalog changed/,
  );

  assert.equal(readFileSync(files.catalogPath, 'utf8'), concurrentCatalog);
  assert.equal(readFileSync(files.mapPath, 'utf8'), originalMap);
});

test('release image gate accepts only the configured canonical host', () => {
  const directory = path.join(tmpdir(), 'nailmania-image-policy-config');
  const policy = catalogImagePolicyFromConfig(imageConfig(), directory);
  assert.deepEqual(canonicalCatalogImageIssues([
    { key: 'ONE', image: `${CANONICAL_BASE}/one.jpg ${CANONICAL_BASE}/two.webp?width=900` },
  ], policy), []);
  assert.deepEqual(canonicalCatalogImageIssues([
    { key: 'ONE', image: `${CANONICAL_BASE}/one.jpg https://supplier.example/two.webp` },
    { key: 'TWO', image: `${LEGACY_ORIGIN}/legacy.jpg` },
  ], policy), [
    { key: 'ONE', url: 'https://supplier.example/two.webp' },
    { key: 'TWO', url: `${LEGACY_ORIGIN}/legacy.jpg` },
  ]);
});

test('build-catalog applies canonical same-bucket and exact external mappings from config', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nailmania-image-policy-build-'));
  mkdirSync(path.join(directory, 'src'));
  mkdirSync(path.join(directory, 'tmp'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const legacy = `${LEGACY_ORIGIN}/folder/My%20Photo.webp?width=900&format=webp`;
  const external = 'https://supplier.example/photo.jpg?version=1';
  const mapped = `${CANONICAL_BASE}/mapped.jpg`;
  const lookalike = `${LEGACY_ORIGIN}.attacker.example/photo.jpg`;
  const csv = [
    REQUIRED_HEADER,
    `Brand,SKU-1,Gel lac,One,Description,2,100,0,,,,"${legacy} ${external} ${lookalike}"`,
  ].join('\n');
  const { snapshotText, report } = validateCatalogSheetText(csv, {
    checkedAt: '2026-07-28T00:00:00.000Z',
  });
  assert.equal(report.valid, true);

  writeFileSync(path.join(directory, 'catalog.config.json'), `${JSON.stringify(imageConfig())}\n`);
  writeFileSync(path.join(directory, 'catalog-image-url-map.json'), `${JSON.stringify({
    [external]: mapped,
  })}\n`);
  writeFileSync(path.join(directory, 'nailmania-sheet.csv'), snapshotText);
  writeFileSync(path.join(directory, 'tmp', 'catalog-source.csv'), snapshotText);
  writeFileSync(path.join(directory, 'tmp', 'catalog-validation.json'), `${JSON.stringify(report)}\n`);

  const result = spawnSync(process.execPath, [
    BUILDER,
    '--validated-snapshot', 'tmp/catalog-source.csv',
    '--validation-report', 'tmp/catalog-validation.json',
  ], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(readFileSync(path.join(directory, 'src', 'catalog.json'), 'utf8'))[0].image,
    `${CANONICAL_BASE}/folder/My%20Photo.webp?width=900&format=webp ${mapped} ${lookalike}`,
  );
});
