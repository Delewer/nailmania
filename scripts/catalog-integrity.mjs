import { createHash } from 'node:crypto';
import {
  catalogImageUrls,
  isValidCatalogImageUrl,
} from '../shared/catalog-images.js';

export { catalogImageUrls } from '../shared/catalog-images.js';

export const CATALOG_VALIDATION_SCHEMA_VERSION = 1;

export const REQUIRED_CATALOG_HEADERS = [
  'brand',
  'sku',
  'category',
  'title',
  'text',
  'quantity',
  'price',
  'price old',
  'sale',
  'new',
  'promo',
  'foto',
];

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalCsvText(value) {
  return `${String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n*$/, '')}\n`;
}

export function csvRows(text) {
  const canonical = canonicalCsvText(text);
  const firstLine = canonical.split('\n').find((line) => line.trim()) || '';
  const delimiter = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < canonical.length; index += 1) {
    const character = canonical[index];
    if (quoted) {
      if (character === '"') {
        if (canonical[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error('Catalog CSV contains an unterminated quoted field');
  return rows.map((cells) => cells.map((cell) => cell.trim()));
}

const normalizedHeader = (value) => String(value || '').trim().toLocaleLowerCase('en-US');
const skuIdentity = (value) => String(value || '').trim().normalize('NFKC').toLocaleUpperCase('en-US');

export function validateCatalogSheetText(rawText, options = {}) {
  const snapshotText = canonicalCsvText(rawText);
  const rows = csvRows(snapshotText);
  const headers = rows.shift() || [];
  const headerIndex = Object.fromEntries(headers.map((header, index) => [normalizedHeader(header), index]));
  const missingHeaders = REQUIRED_CATALOG_HEADERS.filter((header) => headerIndex[header] === undefined);
  const value = (row, column) => {
    const index = headerIndex[column];
    return index === undefined ? '' : String(row[index] || '').trim();
  };
  const products = rows
    .map((row, index) => ({ row, sheetRow: index + 2 }))
    .filter(({ row }) => row.some((cell) => String(cell).trim()));
  const skuGroups = new Map();
  const blankSku = [];
  const invalidQuantity = [];
  const invalidPrice = [];
  const invalidImageUrl = [];
  const blankTitle = [];
  const blankCategory = [];
  const blankDescription = [];
  const blankPhoto = [];
  let totalQuantity = 0;

  for (const { row, sheetRow } of products) {
    const sku = value(row, 'sku');
    const title = value(row, 'title');
    const quantity = value(row, 'quantity');
    const price = value(row, 'price');
    const image = value(row, 'foto');
    const identity = skuIdentity(sku);

    if (!identity) {
      blankSku.push({ row: sheetRow, title });
    } else {
      const entries = skuGroups.get(identity) || [];
      entries.push({ row: sheetRow, sku, title });
      skuGroups.set(identity, entries);
    }
    if (!title) blankTitle.push(sheetRow);
    if (!value(row, 'category')) blankCategory.push(sheetRow);
    if (!value(row, 'text')) blankDescription.push({ row: sheetRow, sku, title });
    if (!image) blankPhoto.push({ row: sheetRow, sku, title });
    else {
      for (const url of catalogImageUrls(image)) {
        if (!isValidCatalogImageUrl(url)) {
          invalidImageUrl.push({ row: sheetRow, sku, title, url });
        }
      }
    }

    if (!/^-?\d+(?:[.,]\d+)?$/.test(quantity)) {
      invalidQuantity.push({ row: sheetRow, sku, value: quantity });
    } else {
      const parsed = Number(quantity.replace(',', '.'));
      if (parsed < 0 || !Number.isInteger(parsed)) {
        invalidQuantity.push({ row: sheetRow, sku, value: quantity });
      } else {
        totalQuantity += parsed;
      }
    }

    if (!/^\d+(?:[.,]\d+)?$/.test(price)) {
      invalidPrice.push({ row: sheetRow, sku, value: price });
    }
  }

  const duplicateSku = [...skuGroups.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([identity, entries]) => ({ sku: entries[0].sku, identity, entries }));
  const errors = {
    missingHeaders,
    blankSku,
    duplicateSku,
    invalidQuantity,
    invalidPrice,
    invalidImageUrl,
    blankTitle,
    blankCategory,
  };
  const warnings = { blankDescription, blankPhoto };
  const errorCount = Object.values(errors).reduce((sum, entries) => sum + entries.length, 0);
  const warningCount = Object.values(warnings).reduce((sum, entries) => sum + entries.length, 0);

  return {
    snapshotText,
    report: {
      schemaVersion: CATALOG_VALIDATION_SCHEMA_VERSION,
      checkedAt: options.checkedAt || new Date().toISOString(),
      sourceUrl: options.sourceUrl || '',
      snapshotSha256: sha256(snapshotText),
      snapshotBytes: Buffer.byteLength(snapshotText),
      valid: errorCount === 0,
      rowCount: products.length,
      uniqueSkuCount: skuGroups.size,
      totalQuantity,
      errorCount,
      warningCount,
      errors,
      warnings,
    },
  };
}

const issue = (index, product, extra = {}) => ({
  index,
  key: String(product?.key || '').trim(),
  sku: String(product?.code || '').trim(),
  title: String(product?.name || '').trim(),
  ...extra,
});

export function validateImportCatalog(catalog, categories) {
  const errors = {
    invalidCatalog: [],
    invalidCategories: [],
    blankSku: [],
    nonCanonicalSku: [],
    duplicateSku: [],
    blankKey: [],
    nonCanonicalKey: [],
    duplicateKey: [],
    unstableKey: [],
    blankTitle: [],
    invalidPrice: [],
    invalidStock: [],
    invalidImageUrl: [],
    missingCategory: [],
    duplicateCategory: [],
  };

  if (!Array.isArray(catalog) || catalog.length === 0) {
    errors.invalidCatalog.push({ reason: 'catalog must be a non-empty array' });
  }
  if (!Array.isArray(categories) || categories.length === 0) {
    errors.invalidCategories.push({ reason: 'categories must be a non-empty array' });
  }

  const safeCatalog = Array.isArray(catalog) ? catalog : [];
  const safeCategories = Array.isArray(categories) ? categories : [];
  const categoryGroups = new Map();
  safeCategories.forEach((category, index) => {
    const id = String(category?.id || '').trim();
    if (!id) {
      errors.invalidCategories.push({ index, reason: 'blank category id' });
      return;
    }
    const entries = categoryGroups.get(id) || [];
    entries.push(index);
    categoryGroups.set(id, entries);
  });
  for (const [id, indexes] of categoryGroups) {
    if (indexes.length > 1) errors.duplicateCategory.push({ id, indexes });
  }

  const skuGroups = new Map();
  const keyGroups = new Map();
  safeCatalog.forEach((product, index) => {
    if (!product || typeof product !== 'object' || Array.isArray(product)) {
      errors.invalidCatalog.push({ index, reason: 'product must be an object' });
      return;
    }
    const rawSku = String(product.code || '');
    const rawKey = String(product.key || '');
    const sku = rawSku.trim();
    const key = rawKey.trim();
    const categoryId = String(product.cat || '').trim();
    const title = String(product.name || '').trim();
    const skuKey = skuIdentity(sku);

    if (!skuKey) errors.blankSku.push(issue(index, product));
    else {
      const entries = skuGroups.get(skuKey) || [];
      entries.push(issue(index, product));
      skuGroups.set(skuKey, entries);
    }
    if (rawSku !== sku) errors.nonCanonicalSku.push(issue(index, product));
    if (!key) errors.blankKey.push(issue(index, product));
    else {
      const entries = keyGroups.get(key) || [];
      entries.push(issue(index, product));
      keyGroups.set(key, entries);
    }
    if (rawKey !== key) errors.nonCanonicalKey.push(issue(index, product));
    if (key && sku && key !== sku) errors.unstableKey.push(issue(index, product));
    if (!title) errors.blankTitle.push(issue(index, product));
    if (!categoryId || !categoryGroups.has(categoryId)) {
      errors.missingCategory.push(issue(index, product, { categoryId }));
    }
    if (!Number.isInteger(Number(product.price)) || Number(product.price) < 0) {
      errors.invalidPrice.push(issue(index, product, { value: product.price }));
    }
    if (product.stock !== undefined && (!Number.isInteger(Number(product.stock)) || Number(product.stock) < 0)) {
      errors.invalidStock.push(issue(index, product, { value: product.stock }));
    }
    for (const url of catalogImageUrls(product.image)) {
      if (!isValidCatalogImageUrl(url)) {
        errors.invalidImageUrl.push(issue(index, product, { url }));
      }
    }
  });

  for (const [identity, entries] of skuGroups) {
    if (entries.length > 1) errors.duplicateSku.push({ identity, entries });
  }
  for (const [key, entries] of keyGroups) {
    if (entries.length > 1) errors.duplicateKey.push({ key, entries });
  }

  const errorCount = Object.values(errors).reduce((sum, entries) => sum + entries.length, 0);
  return {
    schemaVersion: CATALOG_VALIDATION_SCHEMA_VERSION,
    valid: errorCount === 0,
    errorCount,
    productCount: safeCatalog.length,
    categoryCount: safeCategories.length,
    catalogSha256: sha256(`${JSON.stringify(safeCatalog)}\n`),
    categoriesSha256: sha256(`${JSON.stringify(safeCategories)}\n`),
    errors,
  };
}

export class CatalogValidationError extends Error {
  constructor(message, report) {
    super(message);
    this.name = 'CatalogValidationError';
    this.report = report;
  }
}

export function assertImportCatalog(catalog, categories) {
  const report = validateImportCatalog(catalog, categories);
  if (!report.valid) {
    const problemNames = Object.entries(report.errors)
      .filter(([, entries]) => entries.length)
      .map(([name, entries]) => `${name}=${entries.length}`);
    throw new CatalogValidationError(
      `Catalog import validation failed: ${problemNames.join(', ')}`,
      report,
    );
  }
  return report;
}
