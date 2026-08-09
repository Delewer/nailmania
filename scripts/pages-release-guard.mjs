import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { releaseBundleDigest } from './release-bundle.mjs';

export const PAGES_PROJECT = 'nailmania';
export const PAGES_TARGETS = Object.freeze({
  preview: Object.freeze({ branch: 'd1-preview-bootstrap' }),
  production: Object.freeze({ branch: 'main' }),
});
export const D1_TARGETS = Object.freeze({
  preview: Object.freeze({ database: 'nailmania-preview' }),
  production: Object.freeze({ database: 'nailmania-production' }),
});
export const PREVIEW_ORIGIN = 'https://d1-preview-bootstrap.nailmania.pages.dev';
export const BUILD_MANIFEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const PREVIEW_ACCEPTANCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const D1_RELEASE_MANIFEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SHA256 = /^[a-f0-9]{64}$/i;
const COMMIT = /^[a-f0-9]{40}$/i;
const VITE_PUBLIC_INPUT_NAMES = Object.freeze(['VITE_TURNSTILE_SITE_KEY']);

function requireVitePublicInputContract(manifest, label) {
  if (manifest?.vitePublicInputContract !== 1
      || JSON.stringify(manifest?.vitePublicInputNames) !== JSON.stringify(VITE_PUBLIC_INPUT_NAMES)) {
    throw new Error(`${label} does not enforce the reviewed public Vite input contract`);
  }
}

function requireTarget(environment) {
  const target = PAGES_TARGETS[environment];
  if (!target) throw new Error('Pages release requires --environment preview|production');
  return target;
}

function requireRecentIso(value, label, nowMs, maxAgeMs) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must contain a valid timestamp`);
  const age = nowMs - timestamp;
  if (age < -5 * 60 * 1000) throw new Error(`${label} timestamp is in the future`);
  if (age > maxAgeMs) throw new Error(`${label} is stale; create fresh release evidence`);
  return new Date(timestamp).toISOString();
}

function requireFullCommit(value, label) {
  const commit = String(value || '').trim();
  if (!COMMIT.test(commit)) throw new Error(`${label} must be a full 40-character Git commit`);
  return commit.toLowerCase();
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function expectedDeployConfirmation(environment, commit) {
  const target = requireTarget(environment);
  return `DEPLOY PAGES ${PAGES_PROJECT} ${target.branch} ${commit}`;
}

export function expectedPreviewAcceptanceConfirmation(commit) {
  return `ACCEPT PREVIEW ${PAGES_PROJECT} ${PAGES_TARGETS.preview.branch} ${commit}`;
}

export function requireSafePreviewUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('Preview acceptance requires a valid preview URL');
  }
  if (url.protocol !== 'https:') throw new Error('Preview URL must use HTTPS');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Preview URL must not contain credentials, query parameters or a fragment');
  }
  if (url.pathname && url.pathname !== '/') {
    throw new Error('Preview URL must contain only the public deployment origin');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  const localIpv4 = ipv4 && (
    Number(ipv4[1]) === 127
    || Number(ipv4[1]) === 10
    || (Number(ipv4[1]) === 172 && Number(ipv4[2]) >= 16 && Number(ipv4[2]) <= 31)
    || (Number(ipv4[1]) === 192 && Number(ipv4[2]) === 168)
    || (Number(ipv4[1]) === 169 && Number(ipv4[2]) === 254)
    || hostname === '0.0.0.0'
  );
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname === '::1'
    || hostname.startsWith('::ffff:127.')
    || localIpv4
  ) {
    throw new Error('Preview URL must be a public non-loopback HTTPS URL');
  }
  if (url.origin !== PREVIEW_ORIGIN) {
    throw new Error(`Preview URL must be exactly ${PREVIEW_ORIGIN}`);
  }
  return PREVIEW_ORIGIN;
}

export function validateBuildManifest({
  manifest,
  environment,
  expectedCommit,
  actualBundleSha256,
  actualFiles,
  nowMs = Date.now(),
  maxAgeMs = BUILD_MANIFEST_MAX_AGE_MS,
}) {
  requireTarget(environment);
  const commit = requireFullCommit(expectedCommit, '--expected-commit');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Pages build manifest must be a JSON object');
  }
  if (manifest.environment !== environment) {
    throw new Error(`Pages build manifest target mismatch: expected ${environment}`);
  }
  if (requireFullCommit(manifest.commit, 'Pages build manifest commit') !== commit) {
    throw new Error('Pages build manifest commit does not match --expected-commit');
  }
  requireRecentIso(manifest.completedAt, 'Pages build manifest', nowMs, maxAgeMs);
  if (!SHA256.test(String(manifest.bundleSha256 || ''))) {
    throw new Error('Pages build manifest has an invalid bundle SHA-256');
  }
  if (String(manifest.bundleSha256).toLowerCase() !== String(actualBundleSha256).toLowerCase()) {
    throw new Error('dist bundle SHA-256 does not match the Pages build manifest');
  }
  if (!Number.isInteger(manifest.files) || manifest.files <= 0 || manifest.files !== actualFiles) {
    throw new Error('dist file count does not match the Pages build manifest');
  }
  if (!SHA256.test(String(manifest.turnstileSiteKeySha256 || ''))) {
    throw new Error('Pages build manifest is missing the Turnstile site-key fingerprint');
  }
  requireVitePublicInputContract(manifest, 'Pages build manifest');
  return {
    commit,
    bundleSha256: String(manifest.bundleSha256).toLowerCase(),
    completedAt: new Date(Date.parse(manifest.completedAt)).toISOString(),
  };
}

export function validateGitReleaseState({ gitState, environment, expectedCommit }) {
  const target = requireTarget(environment);
  const commit = requireFullCommit(expectedCommit, '--expected-commit');
  if (requireFullCommit(gitState?.head, 'Git HEAD') !== commit) {
    throw new Error('Git HEAD does not match --expected-commit');
  }
  if (String(gitState?.status || '').trim()) {
    throw new Error('Pages release requires a clean Git worktree, including untracked files');
  }
  if (gitState?.branch !== target.branch) {
    throw new Error(`Pages ${environment} release must run from branch ${target.branch}`);
  }
  if (gitState?.distIgnored !== true) {
    throw new Error('dist must remain Git-ignored and be verified through its release manifest');
  }
  return { commit, branch: target.branch };
}

export function validateD1ReleaseManifest({
  manifest,
  manifestSha256,
  environment,
  operation,
  expectedCommit,
  nowMs = Date.now(),
  maxAgeMs = D1_RELEASE_MANIFEST_MAX_AGE_MS,
}) {
  const target = D1_TARGETS[environment];
  if (!target) throw new Error('D1 release evidence requires environment preview|production');
  const commit = requireFullCommit(expectedCommit, '--expected-commit');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`D1 ${operation} release manifest must be a JSON object`);
  }
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'd1-release-operation') {
    throw new Error(`D1 ${operation} release manifest has an unsupported format`);
  }
  if (manifest.environment !== environment || manifest.database !== target.database) {
    throw new Error(`D1 ${operation} release manifest points to the wrong target`);
  }
  if (manifest.operation !== operation) {
    throw new Error(`D1 release manifest must attest the ${operation} operation`);
  }
  if (requireFullCommit(manifest.commit, `D1 ${operation} release manifest commit`) !== commit) {
    throw new Error(`D1 ${operation} release manifest commit does not match the Pages release`);
  }
  const completedAt = requireRecentIso(
    manifest.completedAt,
    `D1 ${operation} release manifest`,
    nowMs,
    maxAgeMs,
  );
  if (!SHA256.test(String(manifestSha256 || ''))) {
    throw new Error(`D1 ${operation} release manifest requires its exact SHA-256 fingerprint`);
  }
  if (!SHA256.test(String(manifest.backup?.sha256 || ''))
      || !SHA256.test(String(manifest.backup?.bookmarkSha256 || ''))) {
    throw new Error(`D1 ${operation} release manifest is missing verified backup evidence`);
  }
  if (!SHA256.test(String(manifest.migrationIntegrity?.manifestSha256 || ''))
      || !Number.isInteger(manifest.migrationIntegrity?.files)
      || manifest.migrationIntegrity.files < 1
      || !/^\d{4}_[a-z0-9_-]+\.sql$/.test(String(manifest.migrationIntegrity?.latest || ''))) {
    throw new Error(`D1 ${operation} release manifest is missing migration integrity evidence`);
  }
  if (operation === 'catalog') {
    const catalog = manifest.catalog;
    if (!catalog
        || !SHA256.test(String(catalog.snapshotSha256 || ''))
        || !SHA256.test(String(catalog.validationReportSha256 || ''))
        || !SHA256.test(String(catalog.catalogSha256 || ''))
        || !SHA256.test(String(catalog.categoriesSha256 || ''))
        || !SHA256.test(String(catalog.sqlSha256 || ''))
        || catalog.postconditions?.valid !== true
        || !SHA256.test(String(catalog.postconditions?.sha256 || ''))) {
      throw new Error('D1 catalog release manifest is missing successful catalog postconditions');
    }
  }
  return {
    operation,
    environment,
    database: target.database,
    commit,
    completedAt,
    sha256: String(manifestSha256).toLowerCase(),
    migrationManifestSha256: String(manifest.migrationIntegrity.manifestSha256).toLowerCase(),
  };
}

export function validateD1ReleasePair({
  environment,
  expectedCommit,
  migrationManifest,
  migrationManifestSha256,
  catalogManifest,
  catalogManifestSha256,
  nowMs = Date.now(),
  maxAgeMs = D1_RELEASE_MANIFEST_MAX_AGE_MS,
}) {
  const migration = validateD1ReleaseManifest({
    manifest: migrationManifest,
    manifestSha256: migrationManifestSha256,
    environment,
    operation: 'migrate',
    expectedCommit,
    nowMs,
    maxAgeMs,
  });
  const catalog = validateD1ReleaseManifest({
    manifest: catalogManifest,
    manifestSha256: catalogManifestSha256,
    environment,
    operation: 'catalog',
    expectedCommit,
    nowMs,
    maxAgeMs,
  });
  if (Date.parse(catalog.completedAt) < Date.parse(migration.completedAt)) {
    throw new Error('D1 catalog release manifest must be newer than its migration manifest');
  }
  if (catalog.migrationManifestSha256 !== migration.migrationManifestSha256) {
    throw new Error('D1 migration and catalog release manifests attest different migration sets');
  }
  return {
    environment,
    database: D1_TARGETS[environment].database,
    migrationManifestSha256: migration.sha256,
    catalogManifestSha256: catalog.sha256,
  };
}

export function validateD1MigrationRelease({
  environment,
  expectedCommit,
  migrationManifest,
  migrationManifestSha256,
  nowMs = Date.now(),
  maxAgeMs = D1_RELEASE_MANIFEST_MAX_AGE_MS,
}) {
  const migration = validateD1ReleaseManifest({
    manifest: migrationManifest,
    manifestSha256: migrationManifestSha256,
    environment,
    operation: 'migrate',
    expectedCommit,
    nowMs,
    maxAgeMs,
  });
  return {
    environment,
    database: D1_TARGETS[environment].database,
    migrationManifestSha256: migration.sha256,
  };
}

export function validatePreviewAcceptanceEvidence({
  evidence,
  commit,
  previewManifest,
  previewManifestSha256,
  previewD1,
  nowMs = Date.now(),
  maxAgeMs = PREVIEW_ACCEPTANCE_MAX_AGE_MS,
}) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('Production Pages release requires preview acceptance evidence');
  }
  if (evidence.schemaVersion !== 3 || evidence.kind !== 'pages-preview-acceptance') {
    throw new Error('Preview acceptance evidence has an unsupported format');
  }
  if (evidence.project !== PAGES_PROJECT || evidence.branch !== PAGES_TARGETS.preview.branch) {
    throw new Error('Preview acceptance evidence points to the wrong Pages target');
  }
  if (requireFullCommit(evidence.commit, 'Preview acceptance commit') !== commit) {
    throw new Error('Preview acceptance commit does not match the production build');
  }
  if (!SHA256.test(String(evidence.bundleSha256 || ''))) {
    throw new Error('Preview acceptance has an invalid bundle digest');
  }
  if (!SHA256.test(String(evidence.buildManifestSha256 || ''))) {
    throw new Error('Preview acceptance is missing its build-manifest fingerprint');
  }
  if (!previewManifest || previewManifest.environment !== 'preview') {
    throw new Error('Preview acceptance requires its preview Pages build manifest');
  }
  if (evidence.buildManifestSha256 !== previewManifestSha256) {
    throw new Error('Preview Pages build manifest fingerprint does not match acceptance evidence');
  }
  if (requireFullCommit(previewManifest.commit, 'Preview Pages build manifest commit') !== commit) {
    throw new Error('Preview Pages build manifest commit does not match the production build');
  }
  if (!SHA256.test(String(previewManifest.bundleSha256 || ''))
      || previewManifest.bundleSha256 !== evidence.bundleSha256) {
    throw new Error('Preview acceptance bundle digest does not match its preview build manifest');
  }
  if (!Number.isInteger(previewManifest.files) || previewManifest.files <= 0
      || !SHA256.test(String(previewManifest.turnstileSiteKeySha256 || ''))) {
    throw new Error('Preview Pages build manifest is incomplete');
  }
  requireVitePublicInputContract(previewManifest, 'Preview Pages build manifest');
  requireRecentIso(previewManifest.completedAt, 'Preview Pages build manifest', nowMs, 48 * 60 * 60 * 1000);
  if (!previewD1
      || evidence.d1MigrationManifestSha256 !== previewD1.migrationManifestSha256) {
    throw new Error('Preview acceptance D1 evidence does not match its release manifests');
  }
  if (evidence.confirmed !== true) {
    throw new Error('Preview acceptance lacks explicit recorded confirmation');
  }
  requireSafePreviewUrl(evidence.previewUrl);
  requireRecentIso(evidence.acceptedAt, 'Preview acceptance evidence', nowMs, maxAgeMs);
  return evidence;
}

export function validatePagesDeployGuard({
  environment,
  expectedCommit,
  confirmProject,
  confirmBranch,
  confirmDeploy,
  manifest,
  actualBundleSha256,
  actualFiles,
  gitState,
  previewAcceptance,
  previewManifest,
  previewManifestSha256,
  d1MigrationManifest,
  d1MigrationManifestSha256,
  previewD1MigrationManifest,
  previewD1MigrationManifestSha256,
  nowMs = Date.now(),
}) {
  const target = requireTarget(environment);
  const git = validateGitReleaseState({ gitState, environment, expectedCommit });
  const build = validateBuildManifest({
    manifest,
    environment,
    expectedCommit,
    actualBundleSha256,
    actualFiles,
    nowMs,
  });
  const d1 = validateD1MigrationRelease({
    environment,
    expectedCommit: build.commit,
    migrationManifest: d1MigrationManifest,
    migrationManifestSha256: d1MigrationManifestSha256,
    nowMs,
  });
  if (confirmProject !== PAGES_PROJECT) {
    throw new Error(`Pages release requires --confirm-project ${PAGES_PROJECT}`);
  }
  if (confirmBranch !== target.branch) {
    throw new Error(`Pages release requires --confirm-branch ${target.branch}`);
  }
  const requiredConfirmation = expectedDeployConfirmation(environment, build.commit);
  if (confirmDeploy !== requiredConfirmation) {
    throw new Error(`Pages release requires --confirm-deploy "${requiredConfirmation}"`);
  }
  if (environment === 'production') {
    const previewD1 = validateD1MigrationRelease({
      environment: 'preview',
      expectedCommit: build.commit,
      migrationManifest: previewD1MigrationManifest,
      migrationManifestSha256: previewD1MigrationManifestSha256,
      nowMs,
      maxAgeMs: 48 * 60 * 60 * 1000,
    });
    validatePreviewAcceptanceEvidence({
      evidence: previewAcceptance,
      commit: build.commit,
      previewManifest,
      previewManifestSha256,
      previewD1,
      nowMs,
    });
  }
  return {
    environment,
    project: PAGES_PROJECT,
    branch: git.branch,
    commit: build.commit,
    bundleSha256: build.bundleSha256,
    d1,
  };
}

export function validatePreviewAcceptanceRecord({
  manifest,
  expectedCommit,
  actualBundleSha256,
  actualFiles,
  gitState,
  previewUrl,
  confirmUrl,
  confirmAcceptance,
  manifestSha256,
  d1MigrationManifest,
  d1MigrationManifestSha256,
  nowMs = Date.now(),
}) {
  const git = validateGitReleaseState({
    gitState,
    environment: 'preview',
    expectedCommit,
  });
  const build = validateBuildManifest({
    manifest,
    environment: 'preview',
    expectedCommit,
    actualBundleSha256,
    actualFiles,
    nowMs,
  });
  const d1 = validateD1MigrationRelease({
    environment: 'preview',
    expectedCommit: build.commit,
    migrationManifest: d1MigrationManifest,
    migrationManifestSha256: d1MigrationManifestSha256,
    nowMs,
  });
  const safeUrl = requireSafePreviewUrl(previewUrl);
  if (requireSafePreviewUrl(confirmUrl) !== safeUrl) {
    throw new Error('--confirm-url must exactly confirm the sanitized preview URL');
  }
  const requiredConfirmation = expectedPreviewAcceptanceConfirmation(build.commit);
  if (confirmAcceptance !== requiredConfirmation) {
    throw new Error(`Preview acceptance requires --confirm-acceptance "${requiredConfirmation}"`);
  }
  if (!SHA256.test(String(manifestSha256 || ''))) {
    throw new Error('Preview acceptance requires a valid build-manifest fingerprint');
  }
  return {
    schemaVersion: 3,
    kind: 'pages-preview-acceptance',
    project: PAGES_PROJECT,
    branch: git.branch,
    commit: build.commit,
    bundleSha256: build.bundleSha256,
    buildManifestSha256: manifestSha256,
    d1MigrationManifestSha256: d1.migrationManifestSha256,
    previewUrl: safeUrl,
    acceptedAt: new Date(nowMs).toISOString(),
    confirmed: true,
  };
}

export function resolveReleaseArtifact(root, inputPath, label) {
  const releasesDirectory = path.resolve(root, 'tmp', 'releases');
  const artifact = path.resolve(root, String(inputPath || ''));
  let realReleases;
  let realArtifact;
  try {
    realReleases = realpathSync(releasesDirectory);
    realArtifact = realpathSync(artifact);
  } catch {
    throw new Error(`${label} does not exist under tmp/releases`);
  }
  const relative = path.relative(realReleases, realArtifact);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !statSync(realArtifact).isFile()) {
    throw new Error(`${label} must be a file under tmp/releases`);
  }
  return realArtifact;
}

export function readJsonArtifact(file, label) {
  const bytes = readFileSync(file);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return { value, bytes, sha256: sha256(bytes) };
}

function capture(command, args, root, { allowStatus } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.error) throw result.error;
  if (allowStatus?.includes(result.status)) return result;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${String(result.stderr || '').trim()}`);
  }
  return result;
}

export function collectGitReleaseState(root) {
  const head = capture('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const branch = capture('git', ['branch', '--show-current'], root).stdout.trim();
  const status = capture('git', ['status', '--porcelain', '--untracked-files=all'], root).stdout;
  const ignored = capture(
    'git',
    ['check-ignore', '--quiet', '--no-index', 'dist'],
    root,
    { allowStatus: [0, 1] },
  );
  return { head, branch, status, distIgnored: ignored.status === 0 };
}

export function readPagesReleaseContext({
  root,
  environment,
  manifestPath,
  d1MigrationManifestPath,
  previewAcceptancePath,
  previewManifestPath,
  previewD1MigrationManifestPath,
}) {
  const manifestFile = resolveReleaseArtifact(root, manifestPath, 'Pages build manifest');
  const manifestArtifact = readJsonArtifact(manifestFile, 'Pages build manifest');
  const d1MigrationManifestFile = resolveReleaseArtifact(
    root,
    d1MigrationManifestPath,
    `D1 ${environment} migration release manifest`,
  );
  const d1MigrationManifestArtifact = readJsonArtifact(
    d1MigrationManifestFile,
    `D1 ${environment} migration release manifest`,
  );
  const distDirectory = path.join(root, 'dist');
  const bundle = releaseBundleDigest(distDirectory);
  let previewAcceptance;
  let previewAcceptanceFile;
  let previewManifest;
  let previewManifestFile;
  let previewManifestSha256;
  let previewD1MigrationManifest;
  let previewD1MigrationManifestFile;
  let previewD1MigrationManifestSha256;
  if (environment === 'production') {
    previewAcceptanceFile = resolveReleaseArtifact(
      root,
      previewAcceptancePath,
      'Preview acceptance evidence',
    );
    previewAcceptance = readJsonArtifact(previewAcceptanceFile, 'Preview acceptance evidence').value;
    previewManifestFile = resolveReleaseArtifact(
      root,
      previewManifestPath,
      'Preview Pages build manifest',
    );
    const previewManifestArtifact = readJsonArtifact(previewManifestFile, 'Preview Pages build manifest');
    previewManifest = previewManifestArtifact.value;
    previewManifestSha256 = previewManifestArtifact.sha256;
    previewD1MigrationManifestFile = resolveReleaseArtifact(
      root,
      previewD1MigrationManifestPath,
      'Preview D1 migration release manifest',
    );
    const previewD1MigrationArtifact = readJsonArtifact(
      previewD1MigrationManifestFile,
      'Preview D1 migration release manifest',
    );
    previewD1MigrationManifest = previewD1MigrationArtifact.value;
    previewD1MigrationManifestSha256 = previewD1MigrationArtifact.sha256;
  }
  return {
    manifest: manifestArtifact.value,
    manifestFile,
    manifestSha256: manifestArtifact.sha256,
    actualBundleSha256: bundle.bundleSha256,
    actualFiles: bundle.files.length,
    gitState: collectGitReleaseState(root),
    d1MigrationManifest: d1MigrationManifestArtifact.value,
    d1MigrationManifestFile,
    d1MigrationManifestSha256: d1MigrationManifestArtifact.sha256,
    previewAcceptance,
    previewAcceptanceFile,
    previewManifest,
    previewManifestFile,
    previewManifestSha256,
    previewD1MigrationManifest,
    previewD1MigrationManifestFile,
    previewD1MigrationManifestSha256,
  };
}
