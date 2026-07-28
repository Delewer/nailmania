import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateCatalogSheetText } from './catalog-integrity.mjs';

const ROOT = process.cwd();
const config = JSON.parse(readFileSync(path.join(ROOT, 'catalog.config.json'), 'utf8'));

function csvUrl(raw) {
  const value = String(raw || '').trim();
  const id = value.match(/\/spreadsheets\/d\/([^/]+)/)?.[1];
  if (!id) return value;
  const gid = value.match(/[?#&]gid=([0-9]+)/)?.[1];
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv${gid ? `&gid=${gid}` : ''}`;
}

const sourceUrl = csvUrl(process.env.CATALOG_SHEET_URL || config.sheetUrl);
if (!sourceUrl) throw new Error('Catalog sheet URL is not configured');

const response = await fetch(`${sourceUrl}${sourceUrl.includes('?') ? '&' : '?'}cb=${Date.now()}`, {
  cache: 'no-store',
  headers: { 'cache-control': 'no-cache' },
});
if (!response.ok) throw new Error(`Catalog sheet returned HTTP ${response.status}`);

const { snapshotText, report } = validateCatalogSheetText(await response.text(), { sourceUrl });
const reportDir = path.join(ROOT, 'tmp');
const snapshotPath = path.join(reportDir, 'catalog-source.csv');
const reportPath = path.join(reportDir, 'catalog-validation.json');
mkdirSync(reportDir, { recursive: true });
writeFileSync(snapshotPath, snapshotText);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`Catalog source: ${report.rowCount} rows, ${report.uniqueSkuCount} unique SKU, ${report.totalQuantity} units`);
console.log(`Validation: ${report.errorCount} error(s), ${report.warningCount} warning(s)`);
if (report.errors.blankSku.length) console.error(`- ${report.errors.blankSku.length} product(s) without SKU`);
if (report.errors.duplicateSku.length) {
  console.error(`- duplicate SKU: ${report.errors.duplicateSku.map((item) => item.sku).join(', ')}`);
}
if (report.errors.invalidQuantity.length) {
  console.error(`- ${report.errors.invalidQuantity.length} invalid quantity value(s)`);
}
if (report.errors.invalidPrice.length) console.error(`- ${report.errors.invalidPrice.length} invalid price value(s)`);
if (report.errors.invalidImageUrl.length) {
  console.error(`- ${report.errors.invalidImageUrl.length} invalid image URL value(s)`);
}
if (report.warnings.blankDescription.length) {
  console.warn(`- ${report.warnings.blankDescription.length} product(s) without description`);
}
if (report.warnings.blankPhoto.length) console.warn(`- ${report.warnings.blankPhoto.length} product(s) without photo`);
console.log(`Snapshot SHA-256: ${report.snapshotSha256}`);
console.log(`Snapshot: ${path.relative(ROOT, snapshotPath)}`);
console.log(`Report: ${path.relative(ROOT, reportPath)}`);

if (!report.valid) process.exitCode = 1;
