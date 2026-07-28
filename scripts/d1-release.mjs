import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { verifyMigrationManifest } from './migration-integrity.mjs';

const root = process.cwd();
const argv = process.argv.slice(2);
const operation = argv.shift();
const valueAfter = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? String(argv[index + 1] || '').trim() : '';
};
const environment = valueAfter('--environment');
const targets = {
  preview: { database: 'nailmania-preview', branch: 'd1-preview-bootstrap' },
  production: { database: 'nailmania-production', branch: 'main' },
};
const target = targets[environment];

const usage = `Usage:
  node scripts/d1-release.mjs status --environment <preview|production>
  node scripts/d1-release.mjs backup --environment <preview|production>
  node scripts/d1-release.mjs migrate --environment <preview|production> --confirm <database> --expected-commit <full HEAD SHA> --backup <tmp/backups/...sql>
  node scripts/d1-release.mjs catalog --environment <preview|production> --confirm <database> --expected-commit <full HEAD SHA> --backup <tmp/backups/...sql> --snapshot <csv> --validation-report <json>
  node scripts/d1-release.mjs admin --environment <preview|production> --confirm <database> --expected-commit <full HEAD SHA> --backup <tmp/backups/...sql> --email <address> --confirm-email <address> [--name <name>]

Mutation guards:
  exact environment branch, --expected-commit <full HEAD SHA>, clean worktree and a fresh verified backup
`;

if (!['status', 'backup', 'migrate', 'catalog', 'admin'].includes(operation) || !target) {
  console.error(usage);
  process.exit(2);
}

const run = (command, args, { capture = false } = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) {
      process.stdout.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
    }
    process.exit(result.status || 1);
  }
  return String(result.stdout || '').trim();
};
const wrangler = (...args) => run(process.execPath, [
  path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
  ...args,
]);
const remoteRow = (sql, keys, label = 'remote query') => {
  const raw = run(process.execPath, [
    path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    'd1', 'execute', target.database, '--remote', '--config', 'wrangler.toml',
    '--env', environment, '--command', sql, '--json',
  ], { capture: true });
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`Wrangler returned invalid JSON for ${label}`);
  }
  const find = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = find(entry);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      if (keys.every((key) => Object.hasOwn(value, key))) return value;
      for (const entry of Object.values(value)) {
        const found = find(entry);
        if (found) return found;
      }
    }
    return null;
  };
  const row = find(payload);
  if (!row) throw new Error(`${label} did not return ${keys.join(', ')}`);
  return row;
};
const remoteScalar = (sql, key) => {
  const result = Number(remoteRow(sql, [key], 'remote migration preflight')[key]);
  if (!Number.isFinite(result)) throw new Error(`Remote migration preflight did not return numeric ${key}`);
  return result;
};
const git = (...args) => run('git', args, { capture: true });
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;
const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, '-');

if (operation === 'status') {
  wrangler('d1', 'migrations', 'list', target.database, '--remote', '--config', 'wrangler.toml', '--env', environment);
  process.exit(0);
}

if (operation === 'backup') {
  const backupDirectory = path.join(root, 'tmp', 'backups');
  mkdirSync(backupDirectory, { recursive: true });
  const basename = `${environment}-${stamp}`;
  const sqlPath = path.join(backupDirectory, `${basename}.sql`);
  const bookmarkPath = path.join(backupDirectory, `${basename}.bookmark.json`);
  const metadataPath = path.join(backupDirectory, `${basename}.metadata.json`);
  const timestamp = now.toISOString();

  const bookmark = run(process.execPath, [
    path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    'd1', 'time-travel', 'info', target.database,
    '--timestamp', timestamp, '--json', '--config', 'wrangler.toml', '--env', environment,
  ], { capture: true });
  let bookmarkPayload;
  try {
    bookmarkPayload = JSON.parse(bookmark);
  } catch {
    throw new Error('Wrangler returned an invalid Time Travel bookmark response; backup aborted');
  }
  writeFileSync(bookmarkPath, `${JSON.stringify(bookmarkPayload, null, 2)}\n`);

  wrangler('d1', 'export', target.database, '--remote', '--skip-confirmation', '--output', sqlPath, '--config', 'wrangler.toml', '--env', environment);
  const metadata = {
    schemaVersion: 1,
    environment,
    database: target.database,
    createdAt: timestamp,
    commit: git('rev-parse', 'HEAD'),
    sqlFile: path.relative(root, sqlPath),
    sqlBytes: statSync(sqlPath).size,
    sqlSha256: sha256(sqlPath),
    bookmarkFile: path.relative(root, bookmarkPath),
    bookmarkSha256: sha256(bookmarkPath),
  };
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`Backup saved outside Git-tracked paths: ${path.relative(root, sqlPath)}`);
  console.log(`Metadata: ${path.relative(root, metadataPath)}`);
  process.exit(0);
}

const head = git('rev-parse', 'HEAD');
const status = git('status', '--porcelain');
if (status) throw new Error('Release mutations require a clean Git worktree');
if (valueAfter('--confirm') !== target.database) {
  throw new Error(`Release mutation requires --confirm ${target.database}`);
}

function verifyMutationGuards() {
  if (git('branch', '--show-current') !== target.branch) {
    throw new Error(`${environment} release must run from ${target.branch}`);
  }
  if (valueAfter('--expected-commit') !== head || !/^[a-f0-9]{40}$/i.test(head)) {
    throw new Error(`${environment} release requires --expected-commit ${head}`);
  }
  const backupArg = valueAfter('--backup');
  if (!backupArg) throw new Error(`${environment} release mutation requires --backup tmp/backups/<file>.sql`);
  const backupPath = path.resolve(root, backupArg);
  const allowedDirectory = path.resolve(root, 'tmp', 'backups') + path.sep;
  if (!backupPath.toLowerCase().endsWith('.sql')
      || !backupPath.startsWith(allowedDirectory)
      || !existsSync(backupPath)
      || statSync(backupPath).size < 100) {
    throw new Error(`${environment} release requires a non-empty .sql --backup file under tmp/backups`);
  }
  const metadataPath = backupPath.replace(/\.sql$/i, '.metadata.json');
  if (!existsSync(metadataPath)) throw new Error(`Backup metadata is missing: ${metadataPath}`);
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch {
    throw new Error(`Backup metadata is not valid JSON: ${metadataPath}`);
  }
  const ageMs = Date.now() - Date.parse(metadata.createdAt);
  const bookmarkPath = path.resolve(root, String(metadata.bookmarkFile || ''));
  if (metadata.environment !== environment || metadata.database !== target.database) throw new Error('Backup belongs to another target');
  if (metadata.commit !== head) throw new Error('Backup was not captured from the release commit');
  if (metadata.sqlBytes !== statSync(backupPath).size) throw new Error('Backup size does not match its metadata');
  if (metadata.sqlSha256 !== sha256(backupPath)) throw new Error('Backup checksum does not match its metadata');
  if (!bookmarkPath.startsWith(allowedDirectory)
      || !existsSync(bookmarkPath)
      || metadata.bookmarkSha256 !== sha256(bookmarkPath)) {
    throw new Error('Backup Time Travel bookmark is missing or does not match its metadata');
  }
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 4 * 60 * 60 * 1000) {
    throw new Error(`${environment} backup must be less than four hours old`);
  }
  return {
    path: path.relative(root, backupPath),
    sha256: metadata.sqlSha256,
    createdAt: metadata.createdAt,
    bookmarkPath: path.relative(root, bookmarkPath),
    bookmarkSha256: metadata.bookmarkSha256,
  };
}

const backup = verifyMutationGuards();
const migrationDirectory = path.join(root, 'migrations');
const migrationManifestPath = path.join(migrationDirectory, 'manifest.sha256');
if (!existsSync(migrationDirectory) || !existsSync(migrationManifestPath)) {
  throw new Error('Release mutation requires migrations/manifest.sha256 and migrations/*.sql');
}
const migrationFiles = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const migrationFailures = verifyMigrationManifest({
  migrationFiles,
  manifestText: readFileSync(migrationManifestPath, 'utf8'),
  readMigration: (file) => readFileSync(path.join(migrationDirectory, file), 'utf8'),
});
if (migrationFailures.length) {
  throw new Error(`Migration integrity failed: ${migrationFailures.join('; ')}`);
}
const migrationIntegrity = {
  manifestSha256: sha256(migrationManifestPath),
  files: migrationFiles.length,
  latest: migrationFiles.at(-1),
};
const releaseDirectory = path.join(root, 'tmp', 'releases');
mkdirSync(releaseDirectory, { recursive: true });
let catalogEvidence = null;
let administratorEvidence = null;

if (operation === 'migrate') {
  const promoMigrationApplied = remoteScalar(
    "SELECT COUNT(*) AS count FROM d1_migrations WHERE name = '0009_promotions.sql'",
    'count',
  );
  if (promoMigrationApplied === 0) {
    const promoTableExists = remoteScalar(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'promo_redemptions'",
      'count',
    );
    if (promoTableExists > 0) {
      const legacyRedemptions = remoteScalar('SELECT COUNT(*) AS count FROM promo_redemptions', 'count');
      if (legacyRedemptions !== 0) {
        throw new Error(
          `Migration 0009 preflight failed: found ${legacyRedemptions} legacy promo redemption(s); deterministic backfill is required`,
        );
      }
    }
    console.log('Migration 0009 preflight passed: no legacy promo redemptions.');
  }
  wrangler('d1', 'migrations', 'apply', target.database, '--remote', '--config', 'wrangler.toml', '--env', environment);
} else if (operation === 'catalog') {
  const snapshot = valueAfter('--snapshot');
  const report = valueAfter('--validation-report');
  if (!snapshot || !report || !existsSync(snapshot) || !existsSync(report)) {
    throw new Error('Catalog release requires existing --snapshot and --validation-report files');
  }
  run(process.execPath, [
    'scripts/build-catalog.mjs',
    '--validated-snapshot', snapshot,
    '--validation-report', report,
  ]);
  if (git('status', '--porcelain')) {
    throw new Error('Validated snapshot changes tracked catalog files; review and commit them before remote import');
  }
  run(process.execPath, ['scripts/import-catalog-d1.mjs']);
  const sqlPath = path.join(root, 'tmp', 'd1', 'catalog-import.sql');
  const importReportPath = path.join(root, 'tmp', 'd1', 'catalog-import-report.json');
  const categoriesPath = path.join(root, 'src', 'categories.json');
  let validationReport;
  let importReport;
  let releaseCategories;
  try {
    validationReport = JSON.parse(readFileSync(path.resolve(root, report), 'utf8'));
    importReport = JSON.parse(readFileSync(importReportPath, 'utf8'));
    releaseCategories = JSON.parse(readFileSync(categoriesPath, 'utf8'));
  } catch {
    throw new Error('Catalog validation/import report is missing or invalid JSON');
  }
  const hashes = [
    validationReport.snapshotSha256,
    importReport.catalogSha256,
    importReport.categoriesSha256,
    importReport.sqlSha256,
  ];
  if (!hashes.every((value) => /^[a-f0-9]{64}$/i.test(String(value || '')))
      || importReport.sqlSha256 !== sha256(sqlPath)
      || importReport.categoriesSha256 !== sha256(categoriesPath)) {
    throw new Error('Catalog release evidence is incomplete or the generated SQL checksum does not match');
  }
  const categoryIds = Array.isArray(releaseCategories)
    ? releaseCategories.map((category) => String(category?.id || '').trim())
    : [];
  if (categoryIds.some((id) => !id) || new Set(categoryIds).size !== categoryIds.length) {
    throw new Error('Release categories contain a blank or duplicate id');
  }
  const expectedCounts = {
    activeProducts: Number(importReport.products),
    activeCategories: Number(importReport.categories),
    unexpectedActiveImportCategories: 0,
    referencedCategories: Number(importReport.categories),
    images: Number(importReport.images),
    missingInventory: 0,
    orphanProducts: 0,
    invalidInventory: 0,
    invalidImages: 0,
  };
  if (!Number.isInteger(expectedCounts.activeProducts) || expectedCounts.activeProducts < 1
      || !Number.isInteger(expectedCounts.activeCategories) || expectedCounts.activeCategories < 1
      || categoryIds.length !== expectedCounts.activeCategories
      || !Number.isInteger(expectedCounts.images) || expectedCounts.images < 0) {
    throw new Error('Catalog import report contains invalid expected postcondition counts');
  }
  wrangler(
    'd1', 'execute', target.database, '--remote', '--config', 'wrangler.toml', '--env', environment,
    '--file', sqlPath,
  );
  const postconditionKeys = [
    'active_products',
    'active_categories',
    'unexpected_active_import_categories',
    'referenced_categories',
    'images',
    'missing_inventory',
    'orphan_products',
    'invalid_inventory',
    'invalid_images',
  ];
  const postconditionRow = remoteRow(`
SELECT
  (SELECT COUNT(*) FROM products
    WHERE source_type = 'import' AND is_active = 1) AS active_products,
  (SELECT COUNT(*) FROM categories
    WHERE is_active = 1
      AND id IN (${categoryIds.map(sqlString).join(', ')})) AS active_categories,
  (SELECT COUNT(*) FROM categories
    WHERE source_type = 'import' AND is_active = 1
      AND id NOT IN (${categoryIds.map(sqlString).join(', ')})) AS unexpected_active_import_categories,
  (SELECT COUNT(DISTINCT category_id) FROM products
    WHERE source_type = 'import' AND is_active = 1) AS referenced_categories,
  (SELECT COUNT(*) FROM product_images image
    JOIN products product ON product.id = image.product_id
    WHERE product.source_type = 'import' AND product.is_active = 1) AS images,
  (SELECT COUNT(*) FROM products product
    LEFT JOIN inventory stock
      ON stock.product_id = product.id AND stock.warehouse_id = 1
    WHERE product.source_type = 'import' AND product.is_active = 1
      AND stock.product_id IS NULL) AS missing_inventory,
  (SELECT COUNT(*) FROM products product
    LEFT JOIN categories category ON category.id = product.category_id
    WHERE product.source_type = 'import' AND product.is_active = 1
      AND (category.id IS NULL OR category.is_active <> 1)) AS orphan_products,
  (SELECT COUNT(*) FROM inventory stock
    JOIN products product ON product.id = stock.product_id
    WHERE product.source_type = 'import' AND product.is_active = 1
      AND stock.warehouse_id = 1
      AND (stock.on_hand < 0 OR stock.reserved < 0 OR stock.reserved > stock.on_hand)) AS invalid_inventory,
  (SELECT COUNT(*) FROM product_images image
    JOIN products product ON product.id = image.product_id
    WHERE product.source_type = 'import' AND product.is_active = 1
      AND (image.public_url IS NULL OR trim(image.public_url) = ''
        OR (lower(trim(image.public_url)) NOT LIKE 'https://%'
          AND lower(trim(image.public_url)) NOT LIKE 'http://%'))) AS invalid_images;
  `, postconditionKeys, 'remote catalog postcondition query');
  const actualCounts = {
    activeProducts: Number(postconditionRow.active_products),
    activeCategories: Number(postconditionRow.active_categories),
    unexpectedActiveImportCategories: Number(postconditionRow.unexpected_active_import_categories),
    referencedCategories: Number(postconditionRow.referenced_categories),
    images: Number(postconditionRow.images),
    missingInventory: Number(postconditionRow.missing_inventory),
    orphanProducts: Number(postconditionRow.orphan_products),
    invalidInventory: Number(postconditionRow.invalid_inventory),
    invalidImages: Number(postconditionRow.invalid_images),
  };
  const postconditionFailures = [];
  for (const [name, expected] of Object.entries(expectedCounts)) {
    const actual = actualCounts[name];
    if (!Number.isFinite(actual)) postconditionFailures.push(`${name} is not numeric`);
    else if (actual !== expected) postconditionFailures.push(`${name}: expected ${expected}, got ${actual}`);
  }
  const postconditionReportPath = path.join(
    releaseDirectory,
    `${environment}-catalog-postconditions-${stamp}.json`,
  );
  writeFileSync(postconditionReportPath, `${JSON.stringify({
    schemaVersion: 1,
    environment,
    database: target.database,
    commit: head,
    checkedAt: new Date().toISOString(),
    valid: postconditionFailures.length === 0,
    expected: expectedCounts,
    actual: actualCounts,
    failures: postconditionFailures,
    catalogSha256: importReport.catalogSha256,
    sqlSha256: importReport.sqlSha256,
  }, null, 2)}\n`);
  const postconditions = {
    path: path.relative(root, postconditionReportPath),
    sha256: sha256(postconditionReportPath),
    valid: postconditionFailures.length === 0,
    expected: expectedCounts,
    actual: actualCounts,
  };
  if (postconditionFailures.length) {
    throw new Error(
      `Remote catalog postconditions failed (${postconditionFailures.join('; ')}); evidence: ${postconditions.path}`,
    );
  }
  catalogEvidence = {
    snapshotSha256: validationReport.snapshotSha256,
    validationReportSha256: sha256(path.resolve(root, report)),
    catalogSha256: importReport.catalogSha256,
    categoriesSha256: importReport.categoriesSha256,
    sqlSha256: importReport.sqlSha256,
    postconditions,
  };
} else {
  const email = valueAfter('--email').toLowerCase();
  const confirmedEmail = valueAfter('--confirm-email').toLowerCase();
  if (!email || confirmedEmail !== email) {
    throw new Error('Administrator grant requires matching --email and --confirm-email values');
  }
  const seedArgs = ['scripts/seed-admin.mjs', '--email', email];
  const name = valueAfter('--name');
  if (name) seedArgs.push('--name', name);
  run(process.execPath, seedArgs);
  const sqlPath = path.join(root, 'tmp', 'd1', 'admin-seed.sql');
  const reportPath = path.join(root, 'tmp', 'd1', 'admin-seed-report.json');
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    throw new Error('Administrator grant report is missing or invalid JSON');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(report.emailSha256 || ''))
      || !/^[a-f0-9]{64}$/i.test(String(report.sqlSha256 || ''))
      || report.sqlSha256 !== sha256(sqlPath)) {
    throw new Error('Administrator grant evidence is incomplete or its SQL checksum does not match');
  }
  wrangler(
    'd1', 'execute', target.database, '--remote', '--config', 'wrangler.toml', '--env', environment,
    '--file', sqlPath,
  );
  administratorEvidence = {
    userId: report.userId,
    emailSha256: report.emailSha256,
    sqlSha256: report.sqlSha256,
  };
}

const manifestPath = path.join(releaseDirectory, `${environment}-${operation}-${stamp}.json`);
writeFileSync(manifestPath, `${JSON.stringify({
  schemaVersion: 1,
  kind: 'd1-release-operation',
  environment,
  database: target.database,
  operation,
  commit: head,
  completedAt: new Date().toISOString(),
  backup,
  migrationIntegrity,
  catalog: catalogEvidence,
  administrator: administratorEvidence,
}, null, 2)}\n`);
console.log(`Release operation completed; local manifest: ${path.relative(root, manifestPath)}`);
