import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  expectedDeployConfirmation,
  expectedPreviewAcceptanceConfirmation,
  PREVIEW_ORIGIN,
  requireSafePreviewUrl,
  validatePagesDeployGuard,
  validatePreviewAcceptanceRecord,
} from '../scripts/pages-release-guard.mjs';
import { releaseBundleDigest } from '../scripts/release-bundle.mjs';
import { runPagesDeploy } from '../scripts/pages-release.mjs';

const NOW = Date.parse('2026-07-18T14:00:00.000Z');
const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const BUNDLE = 'c'.repeat(64);
const MANIFEST_SHA = 'd'.repeat(64);
const D1_MIGRATION_MANIFEST_SHA = '6'.repeat(64);
const MIGRATION_SET_SHA = '8'.repeat(64);

const buildManifest = (environment, overrides = {}) => ({
  environment,
  commit: COMMIT,
  completedAt: new Date(NOW - 60_000).toISOString(),
  files: 3,
  bundleSha256: BUNDLE,
  turnstileSiteKeySha256: 'e'.repeat(64),
  vitePublicInputContract: 1,
  vitePublicInputNames: ['VITE_TURNSTILE_SITE_KEY'],
  ...overrides,
});

const gitState = (branch, overrides = {}) => ({
  head: COMMIT,
  branch,
  status: '',
  distIgnored: true,
  ...overrides,
});

const d1Manifest = (environment, operation, overrides = {}) => ({
  schemaVersion: 1,
  kind: 'd1-release-operation',
  environment,
  database: environment === 'preview' ? 'nailmania-preview' : 'nailmania-production',
  operation,
  commit: COMMIT,
  completedAt: new Date(NOW - (operation === 'migrate' ? 120_000 : 60_000)).toISOString(),
  backup: {
    sha256: '1'.repeat(64),
    bookmarkSha256: '2'.repeat(64),
  },
  migrationIntegrity: {
    manifestSha256: MIGRATION_SET_SHA,
    files: 16,
    latest: '0016_product_event_daily_rollups.sql',
  },
  catalog: operation === 'catalog' ? {
    snapshotSha256: '3'.repeat(64),
    validationReportSha256: '4'.repeat(64),
    catalogSha256: '5'.repeat(64),
    categoriesSha256: '9'.repeat(64),
    sqlSha256: 'a'.repeat(64),
    postconditions: {
      valid: true,
      sha256: 'b'.repeat(64),
    },
  } : null,
  administrator: null,
  ...overrides,
});

const previewEvidence = (overrides = {}) => ({
  schemaVersion: 3,
  kind: 'pages-preview-acceptance',
  project: 'nailmania',
  branch: 'd1-preview-bootstrap',
  commit: COMMIT,
  bundleSha256: BUNDLE,
  buildManifestSha256: MANIFEST_SHA,
  d1MigrationManifestSha256: D1_MIGRATION_MANIFEST_SHA,
  previewUrl: PREVIEW_ORIGIN,
  acceptedAt: new Date(NOW - 30_000).toISOString(),
  confirmed: true,
  ...overrides,
});

const deployInput = (environment, overrides = {}) => {
  const branch = environment === 'preview' ? 'd1-preview-bootstrap' : 'main';
  return {
    environment,
    expectedCommit: COMMIT,
    confirmProject: 'nailmania',
    confirmBranch: branch,
    confirmDeploy: expectedDeployConfirmation(environment, COMMIT),
    manifest: buildManifest(environment),
    actualBundleSha256: BUNDLE,
    actualFiles: 3,
    gitState: gitState(branch),
    d1MigrationManifest: d1Manifest(environment, 'migrate'),
    d1MigrationManifestSha256: D1_MIGRATION_MANIFEST_SHA,
    previewAcceptance: environment === 'production' ? previewEvidence() : undefined,
    previewManifest: environment === 'production' ? buildManifest('preview') : undefined,
    previewManifestSha256: environment === 'production' ? MANIFEST_SHA : undefined,
    previewD1MigrationManifest: environment === 'production' ? d1Manifest('preview', 'migrate') : undefined,
    previewD1MigrationManifestSha256: environment === 'production'
      ? D1_MIGRATION_MANIFEST_SHA
      : undefined,
    nowMs: NOW,
    ...overrides,
  };
};

test('Pages deploy guard rejects stale, tampered, mismatched and dirty release state before spawn', () => {
  let spawnCalls = 0;
  const spawn = () => {
    spawnCalls += 1;
    return { status: 0 };
  };
  const guardThenDeploy = (input) => {
    const plan = validatePagesDeployGuard(input);
    return runPagesDeploy({
      invocation: { command: 'wrangler', args: ['pages', 'deploy'] },
      dryRun: false,
      spawn,
      root: '.',
      plan,
    });
  };

  assert.throws(
    () => guardThenDeploy(deployInput('preview', {
      manifest: buildManifest('preview', { completedAt: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() }),
    })),
    /manifest is stale/,
  );
  assert.throws(
    () => guardThenDeploy(deployInput('preview', { actualBundleSha256: 'f'.repeat(64) })),
    /bundle SHA-256 does not match/,
  );
  assert.throws(
    () => guardThenDeploy(deployInput('preview', { expectedCommit: OTHER_COMMIT })),
    /HEAD does not match/,
  );
  assert.throws(
    () => guardThenDeploy(deployInput('preview', { gitState: gitState('d1-preview-bootstrap', { status: ' M src/App.jsx' }) })),
    /clean Git worktree/,
  );
  assert.throws(
    () => guardThenDeploy(deployInput('preview', { confirmBranch: 'main' })),
    /confirm-branch d1-preview-bootstrap/,
  );
  assert.throws(
    () => guardThenDeploy(deployInput('preview', {
      d1MigrationManifest: d1Manifest('preview', 'migrate', { commit: OTHER_COMMIT }),
    })),
    /D1 migrate release manifest commit does not match/,
  );
  assert.throws(
    () => guardThenDeploy(deployInput('preview', {
      d1MigrationManifest: d1Manifest('preview', 'migrate', {
        migrationIntegrity: {
          manifestSha256: '',
          files: 0,
          latest: '0016_product_event_daily_rollups.sql',
        },
      }),
    })),
    /missing migration integrity evidence/,
  );
  assert.equal(spawnCalls, 0);
});

test('production deploy requires an untampered accepted preview manifest from the same commit', () => {
  assert.equal(validatePagesDeployGuard(deployInput('production')).branch, 'main');
  assert.throws(
    () => validatePagesDeployGuard(deployInput('production', {
      previewAcceptance: previewEvidence({ branch: 'main' }),
    })),
    /wrong Pages target/,
  );
  assert.throws(
    () => validatePagesDeployGuard(deployInput('production', {
      previewAcceptance: previewEvidence({ commit: OTHER_COMMIT }),
    })),
    /commit does not match/,
  );
  assert.throws(
    () => validatePagesDeployGuard(deployInput('production', {
      previewAcceptance: previewEvidence({ bundleSha256: 'f'.repeat(64) }),
    })),
    /bundle digest does not match its preview build manifest/,
  );
  assert.throws(
    () => validatePagesDeployGuard(deployInput('production', {
      previewManifestSha256: 'f'.repeat(64),
    })),
    /fingerprint does not match/,
  );
  assert.throws(
    () => validatePagesDeployGuard(deployInput('production', {
      previewAcceptance: previewEvidence({ confirmed: false }),
    })),
    /explicit recorded confirmation/,
  );
  assert.throws(
    () => validatePagesDeployGuard(deployInput('production', {
      previewAcceptance: previewEvidence({ d1MigrationManifestSha256: 'f'.repeat(64) }),
    })),
    /D1 evidence does not match/,
  );
  assert.throws(
    () => validatePagesDeployGuard(deployInput('production', {
      previewAcceptance: previewEvidence({ acceptedAt: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() }),
    })),
    /acceptance evidence is stale/,
  );
});

test('production may use a separately attested bundle when environment-specific public keys differ', () => {
  const productionBundle = '1'.repeat(64);
  const plan = validatePagesDeployGuard(deployInput('production', {
    manifest: buildManifest('production', { bundleSha256: productionBundle }),
    actualBundleSha256: productionBundle,
  }));
  assert.equal(plan.bundleSha256, productionBundle);
  assert.equal(plan.commit, COMMIT);
});

test('Pages manifests reject builds outside the reviewed Vite public-input contract', () => {
  assert.throws(
    () => validatePagesDeployGuard(deployInput('preview', {
      manifest: buildManifest('preview', { vitePublicInputNames: ['VITE_CATALOG_ENDPOINT'] }),
    })),
    /reviewed public Vite input contract/,
  );
  assert.throws(
    () => validatePagesDeployGuard(deployInput('production', {
      previewManifest: buildManifest('preview', { vitePublicInputContract: 0 }),
    })),
    /reviewed public Vite input contract/,
  );
});

test('preview acceptance rejects loopback and records only sanitized release evidence', () => {
  for (const url of [
    'http://preview.example.test',
    'https://localhost:8797',
    'https://127.0.0.1',
    'https://192.168.1.5',
    'https://preview.example.test/?token=secret',
    'https://preview.example.test/secret-path',
    'https://preview.example.test',
    'https://nailmania.md',
  ]) {
    assert.throws(
      () => requireSafePreviewUrl(url),
      /HTTPS|public non-loopback|query parameters|deployment origin|must be exactly/,
    );
  }

  const accepted = validatePreviewAcceptanceRecord({
    manifest: buildManifest('preview'),
    expectedCommit: COMMIT,
    actualBundleSha256: BUNDLE,
    actualFiles: 3,
    gitState: gitState('d1-preview-bootstrap'),
    d1MigrationManifest: d1Manifest('preview', 'migrate'),
    d1MigrationManifestSha256: D1_MIGRATION_MANIFEST_SHA,
    previewUrl: `${PREVIEW_ORIGIN}/`,
    confirmUrl: PREVIEW_ORIGIN,
    confirmAcceptance: expectedPreviewAcceptanceConfirmation(COMMIT),
    manifestSha256: MANIFEST_SHA,
    nowMs: NOW,
  });
  assert.deepEqual(Object.keys(accepted).sort(), [
    'acceptedAt',
    'branch',
    'buildManifestSha256',
    'bundleSha256',
    'commit',
    'confirmed',
    'd1MigrationManifestSha256',
    'kind',
    'previewUrl',
    'project',
    'schemaVersion',
  ]);
  assert.equal(accepted.previewUrl, PREVIEW_ORIGIN);
  assert.equal(JSON.stringify(accepted).includes('ACCEPT PREVIEW'), false);
});

test('dist tampering changes the exact release bundle digest', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nailmania-pages-bundle-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'assets'));
  writeFileSync(path.join(directory, 'index.html'), '<main>release</main>');
  writeFileSync(path.join(directory, 'assets', 'app.js'), 'window.release=true;');
  const before = releaseBundleDigest(directory);
  writeFileSync(path.join(directory, 'assets', 'app.js'), 'window.release=false;');
  const after = releaseBundleDigest(directory);
  assert.equal(before.files.length, 2);
  assert.notEqual(before.bundleSha256, after.bundleSha256);
});

test('Pages dry-run prints a plan without spawning Wrangler', () => {
  let spawnCalls = 0;
  const result = runPagesDeploy({
    invocation: { command: 'node', args: ['wrangler.js', 'pages', 'deploy', 'dist'] },
    dryRun: true,
    spawn: () => {
      spawnCalls += 1;
      return { status: 0 };
    },
    root: '.',
  });
  assert.equal(result.spawned, false);
  assert.equal(spawnCalls, 0);
});
