import { createHash } from 'node:crypto';
import {
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { releaseBundleDigest } from './release-bundle.mjs';
import {
  readJsonArtifact,
  resolveReleaseArtifact,
  validateD1ReleaseManifest,
} from './pages-release-guard.mjs';

export const RESERVATIONS_CONFIG = 'wrangler.reservations.jsonc';
export const RESERVATIONS_TARGETS = Object.freeze({
  preview: Object.freeze({
    branch: 'd1-preview-bootstrap',
    worker: 'nailmania-reservation-maintenance-preview',
    database: 'nailmania-preview',
    databaseId: '993c4d91-40d0-47d2-8aa5-358a5e18f22e',
  }),
  production: Object.freeze({
    branch: 'main',
    worker: 'nailmania-reservation-maintenance-production',
    database: 'nailmania-production',
    databaseId: '0dab0430-cd49-493a-8a27-d92f22c51cc3',
  }),
});
export const WORKER_BUILD_MANIFEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SHA256 = /^[a-f0-9]{64}$/i;
const COMMIT = /^[a-f0-9]{40}$/i;

function requireTarget(environment) {
  const target = RESERVATIONS_TARGETS[environment];
  if (!target) throw new Error('Reservations release requires --environment preview|production');
  return target;
}

function requireFullCommit(value, label) {
  const commit = String(value || '').trim().toLowerCase();
  if (!COMMIT.test(commit)) throw new Error(`${label} must be a full 40-character Git commit`);
  return commit;
}

function requireRecentIso(value, label, nowMs, maxAgeMs) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must contain a valid timestamp`);
  const age = nowMs - timestamp;
  if (age < -5 * 60 * 1000) throw new Error(`${label} timestamp is in the future`);
  if (age > maxAgeMs) throw new Error(`${label} is stale; rebuild the Worker release artifact`);
  return new Date(timestamp).toISOString();
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function expectedReservationsDeployConfirmation(environment, commit) {
  const target = requireTarget(environment);
  return `DEPLOY RESERVATIONS ${target.worker} ${target.database} ${requireFullCommit(commit, 'commit')}`;
}

export function validateReservationsConfig({ config, environment }) {
  const target = requireTarget(environment);
  const envConfig = config?.env?.[environment];
  const databases = envConfig?.d1_databases;
  if (config?.name !== 'nailmania-reservation-maintenance'
      || String(config?.main || '').replaceAll('\\', '/') !== 'workers/reservations.js'
      || config?.workers_dev !== false) {
    throw new Error('Reservations Wrangler config has an unexpected base worker contract');
  }
  if (envConfig?.name !== target.worker
      || JSON.stringify(envConfig?.triggers?.crons) !== JSON.stringify(['*/5 * * * *'])) {
    throw new Error(`Reservations Wrangler config has an unexpected ${environment} Worker target`);
  }
  if (!Array.isArray(databases)
      || databases.length !== 1
      || databases[0]?.binding !== 'DB'
      || databases[0]?.database_name !== target.database
      || databases[0]?.database_id !== target.databaseId
      || databases[0]?.migrations_dir !== 'migrations') {
    throw new Error(`Reservations Wrangler config has an unexpected ${environment} D1 binding`);
  }
  return target;
}

export function readReservationsConfig(root, environment) {
  const file = path.join(root, RESERVATIONS_CONFIG);
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${RESERVATIONS_CONFIG} must be valid JSON for guarded release`);
  }
  const target = validateReservationsConfig({ config, environment });
  const sourceFile = path.resolve(root, config.main);
  if (!statSync(sourceFile).isFile()) {
    throw new Error('Reservations Worker source entrypoint does not exist');
  }
  return {
    file,
    config,
    target,
    sha256: sha256File(file),
    sourceFile,
    sourceSha256: sha256File(sourceFile),
  };
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

export function collectReservationsGitState(root) {
  const head = capture('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const branch = capture('git', ['branch', '--show-current'], root).stdout.trim();
  const status = capture('git', ['status', '--porcelain', '--untracked-files=all'], root).stdout;
  const ignored = capture(
    'git',
    ['check-ignore', '--quiet', '--no-index', 'tmp/releases'],
    root,
    { allowStatus: [0, 1] },
  );
  return {
    head,
    branch,
    status,
    releasesIgnored: ignored.status === 0,
  };
}

export function validateReservationsGitState({ gitState, environment, expectedCommit }) {
  const target = requireTarget(environment);
  const commit = requireFullCommit(expectedCommit, '--expected-commit');
  if (requireFullCommit(gitState?.head, 'Git HEAD') !== commit) {
    throw new Error('Git HEAD does not match --expected-commit');
  }
  if (String(gitState?.status || '').trim()) {
    throw new Error('Reservations release requires a clean Git worktree, including untracked files');
  }
  if (gitState?.branch !== target.branch) {
    throw new Error(`Reservations ${environment} release must run from branch ${target.branch}`);
  }
  if (gitState?.releasesIgnored !== true) {
    throw new Error('tmp/releases must remain Git-ignored for Worker release artifacts');
  }
  return { ...target, commit };
}

export function validateReservationsBuildManifest({
  manifest,
  environment,
  expectedCommit,
  actualBundleSha256,
  actualFiles,
  actualEntrypointSha256,
  actualConfigSha256,
  actualSourceSha256,
  gitState,
  nowMs = Date.now(),
  maxAgeMs = WORKER_BUILD_MANIFEST_MAX_AGE_MS,
}) {
  const git = validateReservationsGitState({ gitState, environment, expectedCommit });
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Reservations Worker build manifest must be a JSON object');
  }
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'reservations-worker-build') {
    throw new Error('Reservations Worker build manifest has an unsupported format');
  }
  if (manifest.environment !== environment
      || manifest.worker !== git.worker
      || manifest.database !== git.database) {
    throw new Error('Reservations Worker build manifest points to the wrong target');
  }
  if (requireFullCommit(manifest.commit, 'Reservations Worker build manifest commit') !== git.commit) {
    throw new Error('Reservations Worker build manifest commit does not match --expected-commit');
  }
  requireRecentIso(
    manifest.completedAt,
    'Reservations Worker build manifest',
    nowMs,
    maxAgeMs,
  );
  if (!Number.isInteger(manifest.files)
      || manifest.files < 1
      || manifest.files !== actualFiles
      || !SHA256.test(String(manifest.bundleSha256 || ''))
      || manifest.bundleSha256 !== actualBundleSha256) {
    throw new Error('Reservations Worker bundle digest does not match its build manifest');
  }
  if (manifest.entrypoint !== 'reservations.js'
      || !SHA256.test(String(manifest.entrypointSha256 || ''))
      || manifest.entrypointSha256 !== actualEntrypointSha256) {
    throw new Error('Reservations Worker entrypoint digest does not match its build manifest');
  }
  if (!SHA256.test(String(manifest.configSha256 || ''))
      || manifest.configSha256 !== actualConfigSha256) {
    throw new Error('Reservations Worker config digest does not match its build manifest');
  }
  if (!SHA256.test(String(manifest.sourceSha256 || ''))
      || manifest.sourceSha256 !== actualSourceSha256) {
    throw new Error('Reservations Worker source digest does not match its build manifest');
  }
  return {
    environment,
    worker: git.worker,
    database: git.database,
    branch: git.branch,
    commit: git.commit,
    bundleSha256: manifest.bundleSha256,
    entrypointSha256: manifest.entrypointSha256,
  };
}

function resolveUnderReleases(root, inputPath, label, type) {
  const releasesDirectory = realpathSync(path.resolve(root, 'tmp', 'releases'));
  let artifact;
  try {
    artifact = realpathSync(path.resolve(root, String(inputPath || '')));
  } catch {
    throw new Error(`${label} does not exist under tmp/releases`);
  }
  const relative = path.relative(releasesDirectory, artifact);
  const stat = statSync(artifact);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
      || (type === 'file' && !stat.isFile())
      || (type === 'directory' && !stat.isDirectory())) {
    throw new Error(`${label} must be a ${type} under tmp/releases`);
  }
  return artifact;
}

export function readReservationsReleaseContext({
  root,
  environment,
  manifestPath,
  d1MigrationManifestPath,
}) {
  const manifestFile = resolveUnderReleases(root, manifestPath, 'Reservations Worker build manifest', 'file');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch {
    throw new Error('Reservations Worker build manifest is not valid JSON');
  }
  const bundleDirectory = resolveUnderReleases(
    root,
    manifest.bundleDirectory,
    'Reservations Worker bundle',
    'directory',
  );
  const entrypoint = path.join(bundleDirectory, String(manifest.entrypoint || ''));
  if (path.basename(entrypoint) !== manifest.entrypoint
      || !statSync(entrypoint).isFile()
      || realpathSync(path.dirname(entrypoint)) !== bundleDirectory) {
    throw new Error('Reservations Worker entrypoint must be a direct file inside its release bundle');
  }
  const bundle = releaseBundleDigest(bundleDirectory);
  const config = readReservationsConfig(root, environment);
  const d1MigrationManifestFile = resolveReleaseArtifact(
    root,
    d1MigrationManifestPath,
    `D1 ${environment} migration release manifest`,
  );
  const d1MigrationArtifact = readJsonArtifact(
    d1MigrationManifestFile,
    `D1 ${environment} migration release manifest`,
  );
  return {
    manifest,
    manifestFile,
    bundleDirectory,
    entrypoint,
    actualBundleSha256: bundle.bundleSha256,
    actualFiles: bundle.files.length,
    actualEntrypointSha256: sha256File(entrypoint),
    actualConfigSha256: config.sha256,
    actualSourceSha256: config.sourceSha256,
    gitState: collectReservationsGitState(root),
    d1MigrationManifest: d1MigrationArtifact.value,
    d1MigrationManifestFile,
    d1MigrationManifestSha256: d1MigrationArtifact.sha256,
  };
}

export function validateReservationsDeployGuard({
  environment,
  expectedCommit,
  confirmWorker,
  confirmDatabase,
  confirmDeploy,
  d1MigrationManifest,
  d1MigrationManifestSha256,
  nowMs = Date.now(),
  ...context
}) {
  const plan = validateReservationsBuildManifest({
    environment,
    expectedCommit,
    nowMs,
    ...context,
  });
  const d1 = validateD1ReleaseManifest({
    manifest: d1MigrationManifest,
    manifestSha256: d1MigrationManifestSha256,
    environment,
    operation: 'migrate',
    expectedCommit: plan.commit,
    nowMs,
  });
  if (confirmWorker !== plan.worker) {
    throw new Error(`Reservations release requires --confirm-worker ${plan.worker}`);
  }
  if (confirmDatabase !== plan.database) {
    throw new Error(`Reservations release requires --confirm-database ${plan.database}`);
  }
  const requiredConfirmation = expectedReservationsDeployConfirmation(environment, plan.commit);
  if (confirmDeploy !== requiredConfirmation) {
    throw new Error(`Reservations release requires --confirm-deploy "${requiredConfirmation}"`);
  }
  return {
    ...plan,
    d1MigrationManifestSha256: d1.sha256,
  };
}

export function buildReservationsBuildInvocation({ root, environment, outdir }) {
  requireTarget(environment);
  return {
    command: process.execPath,
    args: [
      path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      'deploy',
      '--config', RESERVATIONS_CONFIG,
      '--env', environment,
      '--dry-run',
      '--outdir', outdir,
    ],
  };
}

export function buildReservationsDeployInvocation({ root, environment, entrypoint, plan }) {
  requireTarget(environment);
  return {
    command: process.execPath,
    args: [
      path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      'deploy',
      entrypoint,
      '--no-bundle',
      '--upload-source-maps',
      '--config', RESERVATIONS_CONFIG,
      '--env', environment,
      '--message', `Nail Mania release ${plan.commit}`,
    ],
  };
}

export function runReservationsInvocation({ invocation, root, spawn = spawnSync }) {
  const result = spawn(invocation.command, invocation.args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Wrangler Reservations command failed with exit code ${result.status}`);
  }
  return result;
}
