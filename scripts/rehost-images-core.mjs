import { readFileSync } from 'node:fs';
import {
  atomicWriteText,
  assertFileTextUnchanged,
  collectExternalImageUrls,
  isCanonicalImageUrl,
  readExternalImageUrlMapSnapshot,
  rewriteCatalogImages,
  sortedExternalImageUrlMap,
  writeExternalImageUrlMapAtomic,
} from './catalog-image-policy.mjs';

const catalogText = (catalog) => `${JSON.stringify(catalog)}\n`;

export function assertProductionRehostTarget({ target, publicBaseUrl, policy }) {
  if (target?.environment !== 'production') {
    throw new Error('rehost-images is production-only; preview R2 mutations are forbidden');
  }
  if (target.bucket !== policy.productionBucket) {
    throw new Error(
      `rehost-images requires exact production bucket ${policy.productionBucket}, got ${target.bucket || '<missing>'}`,
    );
  }
  if (publicBaseUrl !== policy.canonicalBaseUrl) {
    throw new Error(
      `rehost-images requires exact production canonical host ${policy.canonicalBaseUrl}`,
    );
  }
  return {
    environment: target.environment,
    bucket: target.bucket,
    publicBaseUrl,
  };
}

export async function rehostCatalogImages({
  catalogPath,
  policy,
  transfer,
  concurrency = 6,
  onProgress = () => {},
}) {
  if (typeof transfer !== 'function') throw new Error('rehostCatalogImages requires a transfer function');

  const originalCatalogText = readFileSync(catalogPath, 'utf8');
  const originalCatalog = JSON.parse(originalCatalogText);
  if (!Array.isArray(originalCatalog)) throw new Error('Catalog must be a JSON array');

  const originalMap = readExternalImageUrlMapSnapshot(policy);
  const existingMap = originalMap.map;
  const normalizedCatalog = rewriteCatalogImages(originalCatalog, policy, existingMap);
  const externalUrls = collectExternalImageUrls(normalizedCatalog, policy);

  if (externalUrls.length === 0) {
    const normalizedText = catalogText(normalizedCatalog);
    if (normalizedText !== originalCatalogText) {
      assertFileTextUnchanged(policy.externalUrlMapPath, originalMap.text, 'external image URL map');
      atomicWriteText(catalogPath, normalizedText, { expectedText: originalCatalogText });
    }
    return {
      ok: true,
      externalCount: 0,
      rehostedCount: 0,
      failures: [],
      catalogChanged: normalizedText !== originalCatalogText,
      mapChanged: false,
    };
  }

  const successful = {};
  const failures = [];
  let cursor = 0;
  let completed = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= externalUrls.length) return;
      const source = externalUrls[index];
      try {
        const destination = await transfer(source);
        if (!isCanonicalImageUrl(destination, policy)) {
          throw new Error(`transfer returned a URL outside ${policy.canonicalBaseUrl}`);
        }
        successful[source] = destination;
      } catch (error) {
        failures.push({
          url: source,
          error: String(error?.message || error),
        });
      }
      completed++;
      onProgress({
        completed,
        total: externalUrls.length,
        successful: Object.keys(successful).length,
        failed: failures.length,
      });
    }
  };

  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, externalUrls.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (failures.length > 0) {
    return {
      ok: false,
      externalCount: externalUrls.length,
      rehostedCount: Object.keys(successful).length,
      failures,
      catalogChanged: false,
      mapChanged: false,
    };
  }

  const mergedMap = sortedExternalImageUrlMap({ ...existingMap, ...successful }, policy);
  const finalCatalog = rewriteCatalogImages(originalCatalog, policy, mergedMap);
  const finalCatalogText = catalogText(finalCatalog);
  const existingMapText = `${JSON.stringify(sortedExternalImageUrlMap(existingMap, policy), null, 2)}\n`;
  const mergedMapText = `${JSON.stringify(mergedMap, null, 2)}\n`;
  const mapChanged = mergedMapText !== existingMapText;
  const catalogChanged = finalCatalogText !== originalCatalogText;

  // Compare both tracked inputs again after the potentially long transfer batch.
  // This prevents a concurrent catalog build, map edit, or second rehost process
  // from being overwritten with a stale snapshot.
  assertFileTextUnchanged(catalogPath, originalCatalogText, 'catalog');
  assertFileTextUnchanged(policy.externalUrlMapPath, originalMap.text, 'external image URL map');

  // The map is the durable source of truth for future catalog builds. Replace it
  // atomically before updating the generated catalog so an interrupted catalog
  // write can be recovered by simply rebuilding.
  if (mapChanged) {
    writeExternalImageUrlMapAtomic(policy, mergedMap, { expectedText: originalMap.text });
  }
  if (catalogChanged) {
    const expectedMapText = mapChanged ? mergedMapText : originalMap.text;
    assertFileTextUnchanged(policy.externalUrlMapPath, expectedMapText, 'external image URL map');
    atomicWriteText(catalogPath, finalCatalogText, { expectedText: originalCatalogText });
  }

  return {
    ok: true,
    externalCount: externalUrls.length,
    rehostedCount: Object.keys(successful).length,
    failures: [],
    catalogChanged,
    mapChanged,
  };
}
