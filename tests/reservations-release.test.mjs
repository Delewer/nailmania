import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { releaseBundleDigest } from '../scripts/release-bundle.mjs';
import {
  buildReservationsDeployInvocation,
  expectedReservationsDeployConfirmation,
  RESERVATIONS_TARGETS,
  sha256File,
  validateReservationsBuildManifest,
  validateReservationsConfig,
  validateReservationsDeployGuard,
} from '../scripts/reservations-release-guard.mjs';
import {
  buildReservationsArtifact,
  runReservationsDeploy,
} from '../scripts/reservations-release.mjs';

const NOW = Date.parse('2026-07-25T03:00:00.000Z');
const COMMIT = 'a'.repeat(40);
const BUNDLE_SHA = 'b'.repeat(64);
const ENTRYPOINT_SHA = 'c'.repeat(64);
const CONFIG_SHA = 'd'.repeat(64);
const SOURCE_SHA = 'e'.repeat(64);
const D1_MANIFEST_SHA = 'f'.repeat(64);

const d1MigrationManifest = (environment, commit = COMMIT, completedAt = new Date(NOW - 120_000).toISOString()) => ({
  schemaVersion: 1,
  kind: 'd1-release-operation',
  environment,
  database: RESERVATIONS_TARGETS[environment].database,
  operation: 'migrate',
  commit,
  completedAt,
  backup: {
    sha256: '1'.repeat(64),
    bookmarkSha256: '2'.repeat(64),
  },
  migrationIntegrity: {
    manifestSha256: '3'.repeat(64),
    files: 13,
    latest: '0014_catalog_discounts_and_promo_brands.sql',
  },
  catalog: null,
  administrator: null,
});

const config = {
  name: 'nailmania-reservation-maintenance',
  main: 'workers/reservations.js',
  workers_dev: false,
  env: {
    preview: {
      name: RESERVATIONS_TARGETS.preview.worker,
      triggers: { crons: ['*/5 * * * *'] },
      d1_databases: [{
        binding: 'DB',
        database_name: RESERVATIONS_TARGETS.preview.database,
        database_id: RESERVATIONS_TARGETS.preview.databaseId,
        migrations_dir: 'migrations',
      }],
    },
    production: {
      name: RESERVATIONS_TARGETS.production.worker,
      triggers: { crons: ['*/5 * * * *'] },
      d1_databases: [{
        binding: 'DB',
        database_name: RESERVATIONS_TARGETS.production.database,
        database_id: RESERVATIONS_TARGETS.production.databaseId,
        migrations_dir: 'migrations',
      }],
    },
  },
};

const gitState = (environment, overrides = {}) => ({
  head: COMMIT,
  branch: RESERVATIONS_TARGETS[environment].branch,
  status: '',
  releasesIgnored: true,
  ...overrides,
});

const manifest = (environment, overrides = {}) => ({
  schemaVersion: 1,
  kind: 'reservations-worker-build',
  environment,
  worker: RESERVATIONS_TARGETS[environment].worker,
  database: RESERVATIONS_TARGETS[environment].database,
  commit: COMMIT,
  completedAt: new Date(NOW - 60_000).toISOString(),
  files: 3,
  bundleSha256: BUNDLE_SHA,
  bundleDirectory: `tmp/releases/${environment}-bundle`,
  entrypoint: 'reservations.js',
  entrypointSha256: ENTRYPOINT_SHA,
  configSha256: CONFIG_SHA,
  sourceSha256: SOURCE_SHA,
  ...overrides,
});

const input = (environment, overrides = {}) => ({
  environment,
  expectedCommit: COMMIT,
  manifest: manifest(environment),
  actualBundleSha256: BUNDLE_SHA,
  actualFiles: 3,
  actualEntrypointSha256: ENTRYPOINT_SHA,
  actualConfigSha256: CONFIG_SHA,
  actualSourceSha256: SOURCE_SHA,
  gitState: gitState(environment),
  d1MigrationManifest: d1MigrationManifest(environment),
  d1MigrationManifestSha256: D1_MANIFEST_SHA,
  nowMs: NOW,
  ...overrides,
});

test('Reservations config and build manifest bind exact Worker, D1, branch, commit and bytes', () => {
  assert.equal(validateReservationsConfig({ config, environment: 'preview' }).database, 'nailmania-preview');
  assert.throws(
    () => validateReservationsConfig({
      config: {
        ...config,
        env: {
          ...config.env,
          preview: {
            ...config.env.preview,
            d1_databases: [{
              ...config.env.preview.d1_databases[0],
              database_name: 'nailmania-production',
            }],
          },
        },
      },
      environment: 'preview',
    }),
    /unexpected preview D1 binding/,
  );

  assert.equal(validateReservationsBuildManifest(input('preview')).worker, RESERVATIONS_TARGETS.preview.worker);
  assert.throws(
    () => validateReservationsBuildManifest(input('preview', {
      actualEntrypointSha256: 'f'.repeat(64),
    })),
    /entrypoint digest/,
  );
  assert.throws(
    () => validateReservationsBuildManifest(input('preview', {
      gitState: gitState('preview', { branch: 'main' }),
    })),
    /must run from branch d1-preview-bootstrap/,
  );
  assert.throws(
    () => validateReservationsBuildManifest(input('production', {
      manifest: manifest('production', { completedAt: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() }),
    })),
    /manifest is stale/,
  );
});

test('Reservations deploy guard requires explicit exact target confirmation and uses --no-bundle', () => {
  const environment = 'production';
  const target = RESERVATIONS_TARGETS[environment];
  const guarded = {
    ...input(environment),
    confirmWorker: target.worker,
    confirmDatabase: target.database,
    confirmDeploy: expectedReservationsDeployConfirmation(environment, COMMIT),
  };
  const plan = validateReservationsDeployGuard(guarded);
  assert.equal(plan.worker, target.worker);
  assert.throws(
    () => validateReservationsDeployGuard({ ...guarded, confirmDatabase: 'nailmania-preview' }),
    /confirm-database nailmania-production/,
  );
  assert.throws(
    () => validateReservationsDeployGuard({
      ...guarded,
      d1MigrationManifest: d1MigrationManifest('production', '9'.repeat(40)),
    }),
    /D1 migrate release manifest commit does not match/,
  );
  const invocation = buildReservationsDeployInvocation({
    root: '/repo',
    environment,
    entrypoint: '/repo/tmp/releases/production-bundle/reservations.js',
    plan,
  });
  assert.ok(invocation.args.includes('--no-bundle'));
  assert.ok(invocation.args.includes('--upload-source-maps'));
  assert.equal(invocation.args.includes('--dry-run'), false);
  assert.ok(invocation.args.includes('/repo/tmp/releases/production-bundle/reservations.js'));
});

test('Reservations build creates a checksummed manifest from Wrangler dry-run output', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nailmania-reservations-build-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'workers'), { recursive: true });
  writeFileSync(path.join(directory, '.gitignore'), 'tmp/\n');
  writeFileSync(path.join(directory, 'wrangler.reservations.jsonc'), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(path.join(directory, 'workers', 'reservations.js'), 'export default { scheduled() {} };\n');
  const runGit = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  runGit('init', '-b', 'd1-preview-bootstrap');
  runGit('config', 'user.email', 'release-test@example.test');
  runGit('config', 'user.name', 'Release test');
  runGit('add', '.');
  runGit('commit', '-m', 'fixture');
  const commit = runGit('rev-parse', 'HEAD');
  let invocations = 0;
  const result = buildReservationsArtifact({
    root: directory,
    environment: 'preview',
    expectedCommit: commit,
    nowMs: NOW,
    run: ({ invocation }) => {
      invocations += 1;
      assert.ok(invocation.args.includes('--dry-run'));
      const outdir = invocation.args[invocation.args.indexOf('--outdir') + 1];
      mkdirSync(outdir, { recursive: true });
      writeFileSync(path.join(outdir, 'reservations.js'), 'export default { scheduled() {} };\n');
      writeFileSync(path.join(outdir, 'README.md'), 'fixture bundle\n');
      return { status: 0 };
    },
  });
  assert.equal(invocations, 1);
  assert.equal(result.manifest.commit, commit);
  assert.equal(result.manifest.worker, RESERVATIONS_TARGETS.preview.worker);
  assert.equal(result.manifest.files, 2);
  assert.match(result.manifest.bundleSha256, /^[a-f0-9]{64}$/);
  assert.match(result.manifest.entrypointSha256, /^[a-f0-9]{64}$/);
});

test('Reservations deploy dry-run validates a persisted bundle without spawning Wrangler', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nailmania-reservations-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const releasesDirectory = path.join(directory, 'tmp', 'releases');
  const bundleDirectory = path.join(releasesDirectory, 'preview-reservations-bundle');
  mkdirSync(bundleDirectory, { recursive: true });
  mkdirSync(path.join(directory, 'workers'), { recursive: true });
  writeFileSync(path.join(directory, '.gitignore'), 'tmp/\n');
  writeFileSync(path.join(directory, 'wrangler.reservations.jsonc'), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(path.join(directory, 'workers', 'reservations.js'), 'export default { scheduled() {} };\n');
  const entrypoint = path.join(bundleDirectory, 'reservations.js');
  writeFileSync(entrypoint, 'export default { scheduled() {} };\n');
  writeFileSync(path.join(bundleDirectory, 'README.md'), 'guarded fixture\n');

  const runGit = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  runGit('init', '-b', 'd1-preview-bootstrap');
  runGit('config', 'user.email', 'release-test@example.test');
  runGit('config', 'user.name', 'Release test');
  runGit('add', '.');
  runGit('commit', '-m', 'fixture');
  const commit = runGit('rev-parse', 'HEAD');
  const bundle = releaseBundleDigest(bundleDirectory);
  const manifestFile = path.join(releasesDirectory, 'preview-reservations-build.json');
  writeFileSync(manifestFile, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'reservations-worker-build',
    environment: 'preview',
    worker: RESERVATIONS_TARGETS.preview.worker,
    database: RESERVATIONS_TARGETS.preview.database,
    commit,
    completedAt: new Date().toISOString(),
    files: bundle.files.length,
    bundleSha256: bundle.bundleSha256,
    bundleDirectory: 'tmp/releases/preview-reservations-bundle',
    entrypoint: 'reservations.js',
    entrypointSha256: sha256File(entrypoint),
    configSha256: sha256File(path.join(directory, 'wrangler.reservations.jsonc')),
    sourceSha256: sha256File(path.join(directory, 'workers', 'reservations.js')),
  }, null, 2)}\n`);
  const d1ManifestFile = path.join(releasesDirectory, 'preview-migrate.json');
  writeFileSync(
    d1ManifestFile,
    `${JSON.stringify(d1MigrationManifest('preview', commit, new Date().toISOString()), null, 2)}\n`,
  );

  let spawnCalls = 0;
  const result = runReservationsDeploy({
    root: directory,
    options: {
      operation: 'deploy',
      environment: 'preview',
      manifestPath: 'tmp/releases/preview-reservations-build.json',
      d1MigrationManifestPath: 'tmp/releases/preview-migrate.json',
      expectedCommit: commit,
      confirmWorker: RESERVATIONS_TARGETS.preview.worker,
      confirmDatabase: RESERVATIONS_TARGETS.preview.database,
      confirmDeploy: expectedReservationsDeployConfirmation('preview', commit),
      dryRun: true,
    },
    spawn: () => {
      spawnCalls += 1;
      return { status: 0 };
    },
  });
  assert.equal(result.spawned, false);
  assert.equal(spawnCalls, 0);

  writeFileSync(entrypoint, 'export default { scheduled() { throw new Error("tampered"); } };\n');
  assert.throws(
    () => runReservationsDeploy({
      root: directory,
      options: {
        operation: 'deploy',
        environment: 'preview',
        manifestPath: 'tmp/releases/preview-reservations-build.json',
        d1MigrationManifestPath: 'tmp/releases/preview-migrate.json',
        expectedCommit: commit,
        confirmWorker: RESERVATIONS_TARGETS.preview.worker,
        confirmDatabase: RESERVATIONS_TARGETS.preview.database,
        confirmDeploy: expectedReservationsDeployConfirmation('preview', commit),
        dryRun: true,
      },
    }),
    /bundle digest/,
  );
});
