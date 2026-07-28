import {
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseBundleDigest } from './release-bundle.mjs';
import {
  buildReservationsBuildInvocation,
  buildReservationsDeployInvocation,
  collectReservationsGitState,
  expectedReservationsDeployConfirmation,
  readReservationsConfig,
  readReservationsReleaseContext,
  runReservationsInvocation,
  sha256File,
  validateReservationsDeployGuard,
  validateReservationsGitState,
} from './reservations-release-guard.mjs';

const VALUE_FLAGS = new Set([
  '--environment',
  '--manifest',
  '--d1-migration-manifest',
  '--expected-commit',
  '--confirm-worker',
  '--confirm-database',
  '--confirm-deploy',
]);

export function parseReservationsReleaseArgs(args) {
  const [operation, ...rest] = args;
  if (!['build', 'deploy'].includes(operation)) {
    throw new Error('Reservations release requires operation build|deploy');
  }
  const values = {};
  let dryRun = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--dry-run') {
      if (dryRun) throw new Error('Duplicate --dry-run');
      dryRun = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown Reservations release argument: ${flag}`);
    if (Object.hasOwn(values, flag)) throw new Error(`Duplicate Reservations release argument: ${flag}`);
    const value = String(rest[index + 1] || '').trim();
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values[flag] = value;
    index += 1;
  }
  if (operation === 'build' && dryRun) {
    throw new Error('Reservations build already uses Wrangler --dry-run and does not accept --dry-run');
  }
  return {
    operation,
    environment: values['--environment'],
    manifestPath: values['--manifest'],
    d1MigrationManifestPath: values['--d1-migration-manifest'],
    expectedCommit: values['--expected-commit'],
    confirmWorker: values['--confirm-worker'],
    confirmDatabase: values['--confirm-database'],
    confirmDeploy: values['--confirm-deploy'],
    dryRun,
  };
}

export function buildReservationsArtifact({
  root,
  environment,
  expectedCommit,
  nowMs = Date.now(),
  run = runReservationsInvocation,
}) {
  const gitState = collectReservationsGitState(root);
  const plan = validateReservationsGitState({ gitState, environment, expectedCommit });
  const config = readReservationsConfig(root, environment);
  const releasesDirectory = path.join(root, 'tmp', 'releases');
  mkdirSync(releasesDirectory, { recursive: true });
  const completedAt = new Date(nowMs).toISOString();
  const stamp = completedAt.replace(/[:.]/g, '-');
  const bundleDirectory = path.join(
    releasesDirectory,
    `${environment}-reservations-bundle-${stamp}`,
  );
  const invocation = buildReservationsBuildInvocation({
    root,
    environment,
    outdir: bundleDirectory,
  });
  run({ invocation, root });

  validateReservationsGitState({
    gitState: collectReservationsGitState(root),
    environment,
    expectedCommit: plan.commit,
  });
  const bundle = releaseBundleDigest(bundleDirectory);
  const entrypoint = path.join(bundleDirectory, 'reservations.js');
  if (!statSync(entrypoint).isFile()) {
    throw new Error('Wrangler dry-run did not create reservations.js');
  }
  const manifest = {
    schemaVersion: 1,
    kind: 'reservations-worker-build',
    environment,
    worker: plan.worker,
    database: plan.database,
    commit: plan.commit,
    completedAt,
    files: bundle.files.length,
    bundleSha256: bundle.bundleSha256,
    bundleDirectory: path.relative(root, bundleDirectory).replaceAll('\\', '/'),
    entrypoint: 'reservations.js',
    entrypointSha256: sha256File(entrypoint),
    configSha256: config.sha256,
    sourceSha256: config.sourceSha256,
  };
  const manifestFile = path.join(
    releasesDirectory,
    `${environment}-reservations-build-${stamp}.json`,
  );
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return { manifest, manifestFile, bundleDirectory, invocation };
}

export function runReservationsDeploy({
  root,
  options,
  spawn = runReservationsInvocation,
  nowMs = Date.now(),
}) {
  const context = readReservationsReleaseContext({
    root,
    environment: options.environment,
    manifestPath: options.manifestPath,
    d1MigrationManifestPath: options.d1MigrationManifestPath,
  });
  const plan = validateReservationsDeployGuard({
    ...options,
    ...context,
    nowMs,
  });
  const invocation = buildReservationsDeployInvocation({
    root,
    environment: options.environment,
    entrypoint: context.entrypoint,
    plan,
  });
  if (options.dryRun) {
    return { spawned: false, plan, invocation };
  }
  spawn({ invocation, root });
  const completedAt = new Date(nowMs).toISOString();
  const stamp = completedAt.replace(/[:.]/g, '-');
  const evidenceFile = path.join(
    root,
    'tmp',
    'releases',
    `${options.environment}-reservations-deploy-${stamp}.json`,
  );
  writeFileSync(evidenceFile, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'reservations-worker-deploy',
    ...plan,
    buildManifestSha256: sha256File(context.manifestFile),
    completedAt,
    confirmed: true,
  }, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return { spawned: true, plan, invocation, evidenceFile };
}

export function main(args = process.argv.slice(2), root = process.cwd()) {
  const options = parseReservationsReleaseArgs(args);
  if (!['preview', 'production'].includes(options.environment)) {
    throw new Error('Reservations release requires --environment preview|production');
  }
  if (!options.expectedCommit) {
    throw new Error('Reservations release requires --expected-commit');
  }
  if (options.operation === 'build') {
    if (options.manifestPath
        || options.d1MigrationManifestPath
        || options.confirmWorker
        || options.confirmDatabase
        || options.confirmDeploy) {
      throw new Error('Reservations build accepts only --environment and --expected-commit');
    }
    const result = buildReservationsArtifact({
      root,
      environment: options.environment,
      expectedCommit: options.expectedCommit,
    });
    console.log(`Reservations Worker bundle verified for ${options.environment} at ${result.manifest.commit}`);
    console.log(`Manifest: ${path.relative(root, result.manifestFile)}`);
    return result;
  }

  if (!options.manifestPath) {
    throw new Error('Reservations deploy requires --manifest under tmp/releases');
  }
  if (!options.d1MigrationManifestPath) {
    throw new Error('Reservations deploy requires --d1-migration-manifest under tmp/releases');
  }
  const result = runReservationsDeploy({ root, options });
  if (options.dryRun) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      spawned: false,
      plan: result.plan,
      command: result.invocation.args.slice(1),
      requiredConfirmation: expectedReservationsDeployConfirmation(
        options.environment,
        result.plan.commit,
      ),
    }, null, 2));
  } else {
    console.log(
      `Reservations Worker ${result.plan.worker} deployed from verified entrypoint ${result.plan.entrypointSha256}`,
    );
    console.log(`Evidence: ${path.relative(root, result.evidenceFile)}`);
  }
  return result;
}

const isEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) main();
