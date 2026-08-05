import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { requirePublicBaseUrl, requireR2MutationTarget } from '../scripts/r2-target-guard.mjs';
import { migrationSha256, verifyMigrationManifest } from '../scripts/migration-integrity.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'));
const SEED_ADMIN = path.join(ROOT, 'scripts', 'seed-admin.mjs');
const D1_RELEASE = path.join(ROOT, 'scripts', 'd1-release.mjs');
const MIGRATION_INTEGRITY = path.join(ROOT, 'scripts', 'migration-integrity.mjs');
const RELEASE_BUILD = path.join(ROOT, 'scripts', 'release-build.mjs');
const RELEASE_BUNDLE = path.join(ROOT, 'scripts', 'release-bundle.mjs');
const TURNSTILE_BUILD_GUARD = path.join(ROOT, 'scripts', 'turnstile-build-guard.mjs');
const CATALOG_IMAGE_POLICY = path.join(ROOT, 'scripts', 'catalog-image-policy.mjs');
const CATALOG_IMAGES = path.join(ROOT, 'shared', 'catalog-images.js');

function writeCanonicalImagePolicyFixture(directory) {
  mkdirSync(path.join(directory, 'src'), { recursive: true });
  writeFileSync(path.join(directory, 'catalog.config.json'), `${JSON.stringify({
    sheetUrl: '',
    imagePolicy: {
      canonicalBaseUrl: 'https://images.example.test',
      productionBucket: 'production-images',
      legacySameBucketOrigins: ['https://legacy-images.example.test'],
      externalUrlMapFile: 'catalog-image-url-map.json',
    },
  })}\n`);
  writeFileSync(path.join(directory, 'catalog-image-url-map.json'), '{}\n');
  writeFileSync(path.join(directory, 'src', 'catalog.json'), `${JSON.stringify([
    { key: 'FIXTURE', image: 'https://images.example.test/fixture.webp' },
  ])}\n`);
}

function writeCatalogImagesFixture(directory) {
  mkdirSync(path.join(directory, 'shared'), { recursive: true });
  copyFileSync(CATALOG_IMAGES, path.join(directory, 'shared', 'catalog-images.js'));
  writeFileSync(path.join(directory, 'shared', 'package.json'), '{"type":"module"}\n');
}

test('migration checksum manifest rejects filename and content drift', () => {
  const migrations = {
    '0001_initial.sql': 'CREATE TABLE example (id INTEGER);\n',
    '0002_more.sql': 'ALTER TABLE example ADD COLUMN name TEXT;\n',
  };
  const manifest = Object.entries(migrations)
    .map(([file, sql]) => `${migrationSha256(sql)}  ${file}`)
    .join('\n') + '\n';
  const verify = (files, text, source = migrations) => verifyMigrationManifest({
    migrationFiles: files,
    manifestText: text,
    readMigration: (file) => source[file],
  });

  assert.deepEqual(verify(Object.keys(migrations), manifest), []);
  assert.match(
    verify(Object.keys(migrations), manifest, {
      ...migrations,
      '0001_initial.sql': `${migrations['0001_initial.sql']}-- edited\n`,
    }).join('\n'),
    /0001_initial\.sql checksum drifted/,
  );
  assert.match(
    verify(['0001_initial.sql'], manifest).join('\n'),
    /filenames\/order do not match/,
  );
});

test('administrator helper only generates checksummed SQL and cannot mutate remote D1 directly', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nailmania-admin-seed-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  for (const args of [
    ['--apply-preview'],
    ['--apply-production', '--confirm-production'],
  ]) {
    const refused = spawnSync(process.execPath, [SEED_ADMIN, ...args], { cwd: directory, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Direct remote administrator changes are disabled/);
  }

  const generated = spawnSync(process.execPath, [
    SEED_ADMIN,
    '--email', "owner.o'reilly@example.test",
    '--name', "Owner O'Reilly",
  ], { cwd: directory, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const sql = readFileSync(path.join(directory, 'tmp', 'd1', 'admin-seed.sql'), 'utf8');
  const report = JSON.parse(readFileSync(path.join(directory, 'tmp', 'd1', 'admin-seed-report.json'), 'utf8'));
  assert.match(sql, /owner\.o''reilly@example\.test/);
  assert.match(sql, /Owner O''Reilly/);
  assert.match(sql, /'admin', 'active'/);
  assert.equal(report.role, 'admin');
  assert.equal(report.sqlSha256, createHash('sha256').update(sql).digest('hex'));
  assert.match(report.emailSha256, /^[a-f0-9]{64}$/);
  assert.equal(sql.includes('--remote'), false);

  const manager = spawnSync(process.execPath, [
    SEED_ADMIN,
    '--email', 'seller@example.test',
    '--role', 'manager',
    '--name', 'Store Seller',
  ], { cwd: directory, encoding: 'utf8' });
  assert.equal(manager.status, 0, manager.stderr);
  const managerSql = readFileSync(path.join(directory, 'tmp', 'd1', 'admin-seed.sql'), 'utf8');
  const managerReport = JSON.parse(
    readFileSync(path.join(directory, 'tmp', 'd1', 'admin-seed-report.json'), 'utf8'),
  );
  assert.match(managerSql, /'manager', 'active'/);
  assert.match(managerSql, /role = excluded\.role/);
  assert.equal(managerReport.role, 'manager');
  assert.equal(managerReport.sqlSha256, createHash('sha256').update(managerSql).digest('hex'));

  const invalidRole = spawnSync(process.execPath, [
    SEED_ADMIN,
    '--email', 'seller@example.test',
    '--role', 'owner',
  ], { cwd: directory, encoding: 'utf8' });
  assert.notEqual(invalidRole.status, 0);
  assert.match(invalidRole.stderr, /--role must be either manager or admin/);
});

test('R2 public base guard accepts only an explicit safe HTTPS base', () => {
  assert.equal(
    requirePublicBaseUrl(['--public-base-url', 'https://images.example.test/catalog/']),
    'https://images.example.test/catalog',
  );
  assert.throws(
    () => requirePublicBaseUrl(['--public-base-url', 'http://images.example.test']),
    /must be an HTTPS/,
  );
  assert.throws(
    () => requirePublicBaseUrl(['--public-base-url', 'https://images.example.test/?token=secret']),
    /without credentials, query or fragment/,
  );
  assert.throws(
    () => requirePublicBaseUrl(
      ['--public-base-url', 'https://pub-example.r2.dev'],
      {},
      'production',
    ),
    /must use a custom domain/,
  );
  assert.equal(
    requirePublicBaseUrl(
      ['--public-base-url', 'https://images.example.test/catalog/'],
      {},
      'production',
    ),
    'https://images.example.test/catalog',
  );
});

test('R2 target guard binds mutations to the configured bucket, clean worktree and exact commit', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nailmania-r2-guard-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runGit = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  runGit('init', '-b', 'main');
  runGit('config', 'user.email', 'release-test@example.test');
  runGit('config', 'user.name', 'Release test');
  writeFileSync(path.join(directory, 'wrangler.toml'), `
[[env.preview.r2_buckets]]
binding = "PRODUCT_IMAGES"
bucket_name = "preview-images"

[[env.production.r2_buckets]]
binding = "PRODUCT_IMAGES"
bucket_name = "production-images"
`);
  writeFileSync(path.join(directory, 'tracked.txt'), 'clean\n');
  runGit('add', '.');
  runGit('commit', '-m', 'fixture');
  const commit = runGit('rev-parse', 'HEAD');

  assert.deepEqual(requireR2MutationTarget({
    root: directory,
    args: [
      '--environment', 'preview',
      '--confirm-bucket', 'preview-images',
      '--expected-commit', commit,
    ],
    env: { R2_BUCKET: 'preview-images' },
  }), { environment: 'preview', bucket: 'preview-images', commit });
  assert.throws(() => requireR2MutationTarget({
    root: directory,
    args: [
      '--environment', 'preview',
      '--confirm-bucket', 'production-images',
      '--expected-commit', commit,
    ],
    env: { R2_BUCKET: 'production-images' },
  }), /R2_BUCKET=preview-images/);

  writeFileSync(path.join(directory, 'tracked.txt'), 'dirty\n');
  assert.throws(() => requireR2MutationTarget({
    root: directory,
    args: [
      '--environment', 'production',
      '--confirm-bucket', 'production-images',
      '--expected-commit', commit,
    ],
    env: { R2_BUCKET: 'production-images' },
  }), /clean Git worktree/);
});

test('production D1 wrapper rejects missing/tampered backup and records a guarded mutation', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nailmania-d1-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scriptsDirectory = path.join(directory, 'scripts');
  const migrationsDirectory = path.join(directory, 'migrations');
  const wranglerDirectory = path.join(directory, 'node_modules', 'wrangler', 'bin');
  const backupDirectory = path.join(directory, 'tmp', 'backups');
  mkdirSync(scriptsDirectory, { recursive: true });
  mkdirSync(migrationsDirectory, { recursive: true });
  mkdirSync(wranglerDirectory, { recursive: true });
  mkdirSync(backupDirectory, { recursive: true });
  copyFileSync(D1_RELEASE, path.join(scriptsDirectory, 'd1-release.mjs'));
  copyFileSync(MIGRATION_INTEGRITY, path.join(scriptsDirectory, 'migration-integrity.mjs'));
  copyFileSync(CATALOG_IMAGE_POLICY, path.join(scriptsDirectory, 'catalog-image-policy.mjs'));
  writeCatalogImagesFixture(directory);
  const fixtureMigration = 'CREATE TABLE fixture (id INTEGER PRIMARY KEY);';
  writeFileSync(path.join(migrationsDirectory, '0001_fixture.sql'), `${fixtureMigration}\n`);
  writeFileSync(
    path.join(migrationsDirectory, 'manifest.sha256'),
    `${migrationSha256(`${fixtureMigration}\n`)}  0001_fixture.sql\n`,
  );
  writeFileSync(path.join(directory, '.gitignore'), 'tmp/\n');
  writeFileSync(path.join(directory, 'wrangler.toml'), '# fixture\n');
  writeFileSync(path.join(wranglerDirectory, 'wrangler.js'), `
const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync(path.join(process.cwd(), 'tmp'), { recursive: true });
fs.appendFileSync(path.join(process.cwd(), 'tmp', 'wrangler-calls.log'), process.argv.slice(2).join(' ') + '\\n');
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify([{ results: [{ count: 1 }] }]));
`);
  const runGit = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  runGit('init', '-b', 'main');
  runGit('config', 'user.email', 'release-test@example.test');
  runGit('config', 'user.name', 'Release test');
  runGit('add', '.');
  runGit('commit', '-m', 'fixture');
  const commit = runGit('rev-parse', 'HEAD');
  const commonArgs = [
    path.join(scriptsDirectory, 'd1-release.mjs'),
    'migrate', '--environment', 'production',
    '--confirm', 'nailmania-production',
    '--expected-commit', commit,
  ];

  const missing = spawnSync(process.execPath, commonArgs, { cwd: directory, encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /requires --backup/);
  const previewWrongBranch = spawnSync(process.execPath, [
    path.join(scriptsDirectory, 'd1-release.mjs'),
    'migrate', '--environment', 'preview', '--confirm', 'nailmania-preview',
    '--expected-commit', commit,
  ], { cwd: directory, encoding: 'utf8' });
  assert.notEqual(previewWrongBranch.status, 0);
  assert.match(previewWrongBranch.stderr, /preview release must run from d1-preview-bootstrap/);
  runGit('switch', '-c', 'd1-preview-bootstrap');
  const previewMissing = spawnSync(process.execPath, [
    path.join(scriptsDirectory, 'd1-release.mjs'),
    'migrate', '--environment', 'preview', '--confirm', 'nailmania-preview',
    '--expected-commit', commit,
  ], { cwd: directory, encoding: 'utf8' });
  assert.notEqual(previewMissing.status, 0);
  assert.match(previewMissing.stderr, /preview release mutation requires --backup/);
  runGit('switch', 'main');

  const sqlPath = path.join(backupDirectory, 'production.sql');
  const bookmarkPath = path.join(backupDirectory, 'production.bookmark.json');
  const metadataPath = path.join(backupDirectory, 'production.metadata.json');
  const sql = '-- release backup\n'.repeat(12);
  const bookmark = '{"bookmark":"fixture"}\n';
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  writeFileSync(sqlPath, sql);
  writeFileSync(bookmarkPath, bookmark);
  writeFileSync(metadataPath, `${JSON.stringify({
    environment: 'production',
    database: 'nailmania-production',
    createdAt: new Date().toISOString(),
    commit,
    sqlBytes: Buffer.byteLength(sql),
    sqlSha256: digest(sql),
    bookmarkFile: 'tmp/backups/production.bookmark.json',
    bookmarkSha256: digest(bookmark),
  })}\n`);
  writeFileSync(bookmarkPath, '{"bookmark":"tampered"}\n');
  const guardedArgs = [...commonArgs, '--backup', 'tmp/backups/production.sql'];
  const tampered = spawnSync(process.execPath, guardedArgs, { cwd: directory, encoding: 'utf8' });
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /bookmark is missing or does not match/);

  writeFileSync(bookmarkPath, bookmark);
  const staffArgs = [
    path.join(scriptsDirectory, 'd1-release.mjs'),
    'admin', '--environment', 'production',
    '--confirm', 'nailmania-production',
    '--expected-commit', commit,
    '--backup', 'tmp/backups/production.sql',
    '--email', 'seller@example.test',
    '--confirm-email', 'seller@example.test',
  ];
  const missingRole = spawnSync(process.execPath, staffArgs, { cwd: directory, encoding: 'utf8' });
  assert.notEqual(missingRole.status, 0);
  assert.match(missingRole.stderr, /requires an explicit --role manager\|admin/);
  const mismatchedRole = spawnSync(process.execPath, [
    ...staffArgs, '--role', 'manager', '--confirm-role', 'admin',
  ], { cwd: directory, encoding: 'utf8' });
  assert.notEqual(mismatchedRole.status, 0);
  assert.match(mismatchedRole.stderr, /matching --role and --confirm-role/);

  const applied = spawnSync(process.execPath, guardedArgs, { cwd: directory, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  const calls = readFileSync(path.join(directory, 'tmp', 'wrangler-calls.log'), 'utf8');
  assert.match(calls, /d1 execute nailmania-production --remote/);
  assert.match(calls, /d1 migrations apply nailmania-production --remote/);
  const releaseDirectory = path.join(directory, 'tmp', 'releases');
  const manifestFiles = readdirSync(releaseDirectory).filter((file) => file.endsWith('.json'));
  assert.equal(manifestFiles.length, 1);
  const manifest = JSON.parse(readFileSync(path.join(releaseDirectory, manifestFiles[0]), 'utf8'));
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'd1-release-operation');
  assert.equal(manifest.operation, 'migrate');
  assert.equal(manifest.migrationIntegrity.files, 1);
  assert.equal(manifest.migrationIntegrity.latest, '0001_fixture.sql');
  assert.equal(manifest.backup.sha256, digest(sql));
  assert.equal(manifest.backup.bookmarkSha256, digest(bookmark));
});

test('catalog D1 wrapper records remote postconditions and fails closed on a mismatch', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nailmania-catalog-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scriptsDirectory = path.join(directory, 'scripts');
  const migrationsDirectory = path.join(directory, 'migrations');
  const sourceDirectory = path.join(directory, 'src');
  const wranglerDirectory = path.join(directory, 'node_modules', 'wrangler', 'bin');
  const backupDirectory = path.join(directory, 'tmp', 'backups');
  mkdirSync(scriptsDirectory, { recursive: true });
  mkdirSync(migrationsDirectory, { recursive: true });
  mkdirSync(sourceDirectory, { recursive: true });
  mkdirSync(wranglerDirectory, { recursive: true });
  mkdirSync(backupDirectory, { recursive: true });
  copyFileSync(D1_RELEASE, path.join(scriptsDirectory, 'd1-release.mjs'));
  copyFileSync(MIGRATION_INTEGRITY, path.join(scriptsDirectory, 'migration-integrity.mjs'));
  copyFileSync(CATALOG_IMAGE_POLICY, path.join(scriptsDirectory, 'catalog-image-policy.mjs'));
  writeCatalogImagesFixture(directory);
  writeCanonicalImagePolicyFixture(directory);
  writeFileSync(path.join(sourceDirectory, 'catalog.json'), `${JSON.stringify([
    {
      id: 1,
      key: 'T1',
      code: 'T1',
      cat: 'category',
      image: 'https://images.example.test/t1.webp',
    },
    {
      id: 2,
      key: 'T2',
      code: 'T2',
      cat: 'category',
      image: 'https://images.example.test/t2-a.webp https://images.example.test/t2-b.webp',
    },
  ])}\n`);
  const fixtureMigration = 'CREATE TABLE fixture (id INTEGER PRIMARY KEY);';
  writeFileSync(path.join(migrationsDirectory, '0001_fixture.sql'), `${fixtureMigration}\n`);
  writeFileSync(
    path.join(migrationsDirectory, 'manifest.sha256'),
    `${migrationSha256(`${fixtureMigration}\n`)}  0001_fixture.sql\n`,
  );
  writeFileSync(path.join(directory, '.gitignore'), 'tmp/\n');
  writeFileSync(path.join(directory, 'wrangler.toml'), '# fixture\n');
  writeFileSync(path.join(scriptsDirectory, 'build-catalog.mjs'), '// validated fixture build\n');
  writeFileSync(path.join(sourceDirectory, 'categories.json'), '[{"id":"category"}]\n');
  writeFileSync(path.join(scriptsDirectory, 'import-catalog-d1.mjs'), `
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('tmp/d1', { recursive: true });
const sql = 'SELECT 1;\\n';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
writeFileSync('tmp/d1/catalog-import.sql', sql);
writeFileSync('tmp/d1/catalog-import-report.json', JSON.stringify({
  products: 2,
  categories: 1,
  images: 3,
  catalogSha256: 'b'.repeat(64),
  categoriesSha256: sha256(readFileSync('src/categories.json')),
  sqlSha256: sha256(sql),
}) + '\\n');
`);
  writeFileSync(path.join(wranglerDirectory, 'wrangler.js'), `
const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync(path.join(process.cwd(), 'tmp'), { recursive: true });
fs.appendFileSync(path.join(process.cwd(), 'tmp', 'wrangler-calls.log'), process.argv.slice(2).join(' ') + '\\n');
if (process.argv.includes('--json')) {
  const commandIndex = process.argv.indexOf('--command');
  const sql = commandIndex === -1 ? '' : String(process.argv[commandIndex + 1] || '').toLowerCase();
  if (sql.includes('catalog_key') && sql.includes('inventory_rows')) {
    const rows = [
      {
        catalog_key: 'T1',
        source_type: 'import',
        is_active: 1,
        category_id: 'category',
        category_active: 1,
        has_admin_revision: 0,
        has_admin_audit: 0,
        inventory_rows: 1,
        invalid_inventory: 0,
        image_count: 1,
        image_urls_json: JSON.stringify(['https://images.example.test/t1.webp']),
      },
      {
        catalog_key: 'T2',
        source_type: 'import',
        is_active: 1,
        category_id: 'category',
        category_active: 1,
        has_admin_revision: 0,
        has_admin_audit: 0,
        inventory_rows: 1,
        invalid_inventory: 0,
        image_count: process.env.POST_IMPORT_IMAGE_MISMATCH === '1' ? 1 : 2,
        image_urls_json: JSON.stringify(process.env.POST_IMPORT_IMAGE_MISMATCH === '1'
          ? ['https://images.example.test/t2-a.webp']
          : ['https://images.example.test/t2-a.webp', 'https://images.example.test/t2-b.webp']),
      },
    ];
    if (process.env.POST_ADMIN_OVERRIDE === '1'
        || process.env.POST_INVALID_ADMIN_INVENTORY === '1'
        || process.env.POST_INVALID_ADMIN_IMAGE === '1'
        || process.env.POST_UNPROVEN_ADMIN === '1'
        || process.env.POST_INACTIVE_ADMIN === '1') {
      Object.assign(rows[0], {
        source_type: 'admin',
        has_admin_revision: process.env.POST_UNPROVEN_ADMIN === '1' ? 0 : 1,
        has_admin_audit: process.env.POST_UNPROVEN_ADMIN === '1' ? 0 : 1,
      });
    }
    if (process.env.POST_INVALID_ADMIN_INVENTORY === '1') rows[0].invalid_inventory = 1;
    if (process.env.POST_INVALID_ADMIN_IMAGE === '1') rows[0].image_urls_json = JSON.stringify(['https://']);
    if (process.env.POST_INACTIVE_ADMIN === '1') rows[0].is_active = 0;
    if (process.env.POST_ACTIVE_PRODUCTS === '1') rows[1].is_active = 0;
    if (process.env.POST_MISSING_PRODUCT === '1') {
      rows.splice(1, 1, {
        catalog_key: 'ADMIN-EXTRA',
        source_type: 'admin',
        is_active: 1,
        category_id: 'category',
        category_active: 1,
        has_admin_revision: 1,
        has_admin_audit: 1,
        inventory_rows: 1,
        invalid_inventory: 0,
        image_count: 1,
        image_urls_json: JSON.stringify(['https://images.example.test/admin-extra.webp']),
      });
    }
    process.stdout.write(JSON.stringify([{ results: rows }]));
  } else if (sql.includes('active_categories') && sql.includes('unexpected_active_import_categories')) {
    process.stdout.write(JSON.stringify([{ results: [{
      active_categories: 1,
      unexpected_active_import_categories: Number(process.env.POST_UNEXPECTED_ACTIVE_IMPORT_CATEGORIES || 0),
    }] }]));
  } else {
    process.stderr.write('Unexpected fixture postcondition query: ' + sql + '\\n');
    process.exitCode = 2;
  }
}
`);
  const runGit = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  runGit('init', '-b', 'main');
  runGit('config', 'user.email', 'release-test@example.test');
  runGit('config', 'user.name', 'Release test');
  runGit('add', '.');
  runGit('commit', '-m', 'fixture');
  const commit = runGit('rev-parse', 'HEAD');

  const snapshotPath = path.join(directory, 'tmp', 'catalog-source.csv');
  const validationPath = path.join(directory, 'tmp', 'catalog-validation.json');
  const sqlBackupPath = path.join(backupDirectory, 'production.sql');
  const bookmarkPath = path.join(backupDirectory, 'production.bookmark.json');
  const metadataPath = path.join(backupDirectory, 'production.metadata.json');
  const backupSql = '-- release backup\n'.repeat(12);
  const bookmark = '{"bookmark":"fixture"}\n';
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  writeFileSync(snapshotPath, 'SKU,Title\nT1,Fixture\n');
  writeFileSync(validationPath, JSON.stringify({ snapshotSha256: 'a'.repeat(64) }) + '\n');
  writeFileSync(sqlBackupPath, backupSql);
  writeFileSync(bookmarkPath, bookmark);
  writeFileSync(metadataPath, `${JSON.stringify({
    environment: 'production',
    database: 'nailmania-production',
    createdAt: new Date().toISOString(),
    commit,
    sqlBytes: Buffer.byteLength(backupSql),
    sqlSha256: digest(backupSql),
    bookmarkFile: 'tmp/backups/production.bookmark.json',
    bookmarkSha256: digest(bookmark),
  })}\n`);
  const command = [
    path.join(scriptsDirectory, 'd1-release.mjs'),
    'catalog', '--environment', 'production',
    '--confirm', 'nailmania-production',
    '--expected-commit', commit,
    '--backup', 'tmp/backups/production.sql',
    '--snapshot', 'tmp/catalog-source.csv',
    '--validation-report', 'tmp/catalog-validation.json',
  ];

  const releaseDirectory = path.join(directory, 'tmp', 'releases');
  const clearReleaseEvidence = () => rmSync(releaseDirectory, { recursive: true, force: true });
  const readPostconditions = () => {
    const file = readdirSync(releaseDirectory)
      .find((candidate) => candidate.includes('catalog-postconditions'));
    assert.ok(file, 'catalog postcondition evidence must be written');
    return JSON.parse(readFileSync(path.join(releaseDirectory, file), 'utf8'));
  };
  const runCatalog = (env = {}) => spawnSync(process.execPath, command, {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

  const passed = runCatalog();
  assert.equal(passed.status, 0, passed.stderr);
  const passedFiles = readdirSync(releaseDirectory);
  const postconditionFile = passedFiles.find((file) => file.includes('catalog-postconditions'));
  const manifestFile = passedFiles.find((file) => file.startsWith('production-catalog-') && !file.includes('postconditions'));
  const postconditions = JSON.parse(readFileSync(path.join(releaseDirectory, postconditionFile), 'utf8'));
  const manifest = JSON.parse(readFileSync(path.join(releaseDirectory, manifestFile), 'utf8'));
  assert.equal(postconditions.schemaVersion, 2);
  assert.equal(postconditions.valid, true);
  assert.equal(postconditions.actual.activeProducts, 2);
  assert.equal(postconditions.actual.images, 3);
  assert.equal(postconditions.actual.unexpectedActiveImportCategories, 0);
  assert.equal(postconditions.adminOverrides.count, 0);
  assert.equal(manifest.catalog.postconditions.valid, true);
  assert.match(manifest.catalog.postconditions.sha256, /^[a-f0-9]{64}$/);

  clearReleaseEvidence();
  const adminOverride = runCatalog({ POST_ADMIN_OVERRIDE: '1' });
  assert.equal(adminOverride.status, 0, adminOverride.stderr);
  const overrideEvidence = readPostconditions();
  assert.equal(overrideEvidence.valid, true);
  assert.equal(overrideEvidence.adminOverrides.count, 1);
  assert.equal(overrideEvidence.adminOverrides.active, 1);
  assert.equal(overrideEvidence.adminOverrides.inactive, 0);
  assert.equal(overrideEvidence.actual.activeProducts, 1);
  assert.equal(overrideEvidence.actual.images, 2);

  clearReleaseEvidence();
  const inactiveAdminOverride = runCatalog({ POST_INACTIVE_ADMIN: '1' });
  assert.equal(inactiveAdminOverride.status, 0, inactiveAdminOverride.stderr);
  const inactiveOverrideEvidence = readPostconditions();
  assert.equal(inactiveOverrideEvidence.valid, true);
  assert.equal(inactiveOverrideEvidence.adminOverrides.count, 1);
  assert.equal(inactiveOverrideEvidence.adminOverrides.active, 0);
  assert.equal(inactiveOverrideEvidence.adminOverrides.inactive, 1);

  clearReleaseEvidence();
  const unprovenAdminOverride = runCatalog({ POST_UNPROVEN_ADMIN: '1' });
  assert.notEqual(unprovenAdminOverride.status, 0);
  const unprovenOverrideEvidence = readPostconditions();
  assert.equal(unprovenOverrideEvidence.valid, false);
  assert.equal(unprovenOverrideEvidence.actual.unprovenAdminCollisions, 1);

  clearReleaseEvidence();
  const missingProduct = runCatalog({ POST_MISSING_PRODUCT: '1' });
  assert.notEqual(missingProduct.status, 0);
  assert.match(missingProduct.stderr, /Remote catalog postconditions failed/);
  const missingEvidence = readPostconditions();
  assert.equal(missingEvidence.valid, false);
  assert.equal(missingEvidence.actual.resolvedCatalogProducts, 1);
  assert.equal(missingEvidence.actual.missingCatalogProducts, 1);
  assert.equal(missingEvidence.adminOverrides.count, 0);
  assert.match(missingEvidence.failures.join('\n'), /T2|missing/i);

  clearReleaseEvidence();
  const invalidAdminInventory = runCatalog({ POST_INVALID_ADMIN_INVENTORY: '1' });
  assert.notEqual(invalidAdminInventory.status, 0);
  assert.match(invalidAdminInventory.stderr, /Remote catalog postconditions failed/);
  const invalidAdminEvidence = readPostconditions();
  assert.equal(invalidAdminEvidence.adminOverrides.count, 1);
  assert.equal(invalidAdminEvidence.valid, false);
  assert.equal(invalidAdminEvidence.actual.invalidInventory, 1);
  assert.match(invalidAdminEvidence.failures.join('\n'), /T1.*inventory|inventory.*T1|invalidInventory/i);

  clearReleaseEvidence();
  const invalidAdminImage = runCatalog({ POST_INVALID_ADMIN_IMAGE: '1' });
  assert.notEqual(invalidAdminImage.status, 0);
  const invalidAdminImageEvidence = readPostconditions();
  assert.equal(invalidAdminImageEvidence.valid, false);
  assert.equal(invalidAdminImageEvidence.actual.invalidImages, 1);

  clearReleaseEvidence();
  const imageMismatch = runCatalog({ POST_IMPORT_IMAGE_MISMATCH: '1' });
  assert.notEqual(imageMismatch.status, 0);
  assert.match(imageMismatch.stderr, /Remote catalog postconditions failed/);
  const imageEvidence = readPostconditions();
  assert.equal(imageEvidence.valid, false);
  assert.equal(imageEvidence.actual.importImageMismatches, 1);
  assert.match(imageEvidence.failures.join('\n'), /T2.*image|image.*T2|images: expected 3, got 2/i);

  clearReleaseEvidence();
  const failed = runCatalog({ POST_ACTIVE_PRODUCTS: '1' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Remote catalog postconditions failed/);
  const failedEvidence = readPostconditions();
  assert.equal(failedEvidence.valid, false);
  assert.equal(failedEvidence.expected.activeProducts, 2);
  assert.equal(failedEvidence.actual.activeProducts, 1);
  assert.match(failedEvidence.failures.join('\n'), /activeProducts: expected 2, got 1/);

  clearReleaseEvidence();
  const staleCategory = runCatalog({ POST_UNEXPECTED_ACTIVE_IMPORT_CATEGORIES: '1' });
  assert.notEqual(staleCategory.status, 0);
  assert.match(staleCategory.stderr, /unexpectedActiveImportCategories: expected 0, got 1/);
});

test('release Pages build fails closed without a production-format Turnstile key and attests injected bytes', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nailmania-release-build-'));
  const siteKey = `0x4${'A'.repeat(21)}B`;
  const siteKeySha256 = createHash('sha256').update(siteKey).digest('hex');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'scripts'), { recursive: true });
  mkdirSync(path.join(directory, 'node_modules', 'vite', 'bin'), { recursive: true });
  copyFileSync(RELEASE_BUILD, path.join(directory, 'scripts', 'release-build.mjs'));
  copyFileSync(RELEASE_BUNDLE, path.join(directory, 'scripts', 'release-bundle.mjs'));
  writeFileSync(
    path.join(directory, 'scripts', 'turnstile-build-guard.mjs'),
    readFileSync(TURNSTILE_BUILD_GUARD, 'utf8').replace(
      '0f44a961818ff168edaaeef99497e5a18e2014f855d89bbb368715fc9ed664b1',
      siteKeySha256,
    ),
  );
  copyFileSync(CATALOG_IMAGE_POLICY, path.join(directory, 'scripts', 'catalog-image-policy.mjs'));
  writeCanonicalImagePolicyFixture(directory);
  writeFileSync(path.join(directory, 'scripts', 'build-seo.mjs'), `
import { appendFileSync } from 'node:fs';
appendFileSync('dist/index.html', '<meta name="seo-fixture">');
`);
  writeFileSync(path.join(directory, 'node_modules', 'vite', 'bin', 'vite.js'), `
const fs = require('node:fs');
fs.mkdirSync('dist/assets', { recursive: true });
fs.writeFileSync('dist/index.html', '<main>fixture</main>');
fs.writeFileSync('dist/assets/app.js', 'window.siteKey=' + JSON.stringify(process.env.VITE_TURNSTILE_SITE_KEY));
`);
  writeFileSync(path.join(directory, '.gitignore'), 'dist/\ntmp/\n.env*\n');
  const runGit = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  runGit('init', '-b', 'main');
  runGit('config', 'user.email', 'release-test@example.test');
  runGit('config', 'user.name', 'Release test');
  runGit('add', '.');
  runGit('commit', '-m', 'fixture');
  const commit = runGit('rev-parse', 'HEAD');
  const command = [
    path.join(directory, 'scripts', 'release-build.mjs'),
    '--environment', 'preview', '--expected-commit', commit,
  ];

  const missing = spawnSync(process.execPath, command, { cwd: directory, encoding: 'utf8', env: { ...process.env, VITE_TURNSTILE_SITE_KEY: '' } });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /requires a production-format VITE_TURNSTILE_SITE_KEY/);
  const testKey = `1x${'0'.repeat(20)}AA`;
  const refusedTestKey = spawnSync(process.execPath, command, {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, VITE_TURNSTILE_SITE_KEY: testKey },
  });
  assert.notEqual(refusedTestKey.status, 0);
  assert.match(refusedTestKey.stderr, /Cloudflare test keys are refused/);

  const refusedProcessInput = spawnSync(process.execPath, command, {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, VITE_TURNSTILE_SITE_KEY: siteKey, VITE_CATALOG_ENDPOINT: 'https://wrong.example/api' },
  });
  assert.notEqual(refusedProcessInput.status, 0);
  assert.match(refusedProcessInput.stderr, /refuses unreviewed public Vite inputs: VITE_CATALOG_ENDPOINT/);

  writeFileSync(path.join(directory, '.env.production'), 'VITE_CATEGORIES_ENDPOINT=https://wrong.example/api\n');
  const refusedFileInput = spawnSync(process.execPath, command, {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, VITE_TURNSTILE_SITE_KEY: siteKey },
  });
  assert.notEqual(refusedFileInput.status, 0);
  assert.match(refusedFileInput.stderr, /refuses unreviewed public Vite inputs in \.env\.production: VITE_CATEGORIES_ENDPOINT/);
  rmSync(path.join(directory, '.env.production'));

  const built = spawnSync(process.execPath, command, {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, VITE_TURNSTILE_SITE_KEY: siteKey },
  });
  assert.equal(built.status, 0, built.stderr);
  assert.match(readFileSync(path.join(directory, 'dist', 'assets', 'app.js'), 'utf8'), new RegExp(siteKey));
  const manifests = readdirSync(path.join(directory, 'tmp', 'releases')).filter((file) => file.endsWith('.json'));
  assert.equal(manifests.length, 1);
  const manifest = JSON.parse(readFileSync(path.join(directory, 'tmp', 'releases', manifests[0]), 'utf8'));
  assert.equal(manifest.environment, 'preview');
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.turnstileSiteKeySha256, createHash('sha256').update(siteKey).digest('hex'));
  assert.equal(manifest.vitePublicInputContract, 1);
  assert.deepEqual(manifest.vitePublicInputNames, ['VITE_TURNSTILE_SITE_KEY']);
  assert.match(manifest.bundleSha256, /^[a-f0-9]{64}$/);

  writeFileSync(path.join(directory, 'src', 'catalog.json'), `${JSON.stringify([
    { key: 'EXTERNAL', image: 'https://supplier.example/fixture.webp' },
  ])}\n`);
  runGit('add', 'src/catalog.json');
  runGit('commit', '-m', 'external image fixture');
  const externalCommit = runGit('rev-parse', 'HEAD');
  const refusedExternal = spawnSync(process.execPath, [
    path.join(directory, 'scripts', 'release-build.mjs'),
    '--environment', 'preview', '--expected-commit', externalCommit,
  ], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, VITE_TURNSTILE_SITE_KEY: siteKey },
  });
  assert.notEqual(refusedExternal.status, 0);
  assert.match(refusedExternal.stderr, /non-canonical image URL/);
});
