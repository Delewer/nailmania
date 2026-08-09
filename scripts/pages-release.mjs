import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAGES_PROJECT,
  PAGES_TARGETS,
  readPagesReleaseContext,
  validatePagesDeployGuard,
} from './pages-release-guard.mjs';

const VALUE_FLAGS = new Set([
  '--environment',
  '--manifest',
  '--d1-migration-manifest',
  '--expected-commit',
  '--confirm-project',
  '--confirm-branch',
  '--confirm-deploy',
  '--preview-acceptance',
  '--preview-manifest',
  '--preview-d1-migration-manifest',
]);

export function parsePagesReleaseArgs(args) {
  const values = {};
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--dry-run') {
      if (dryRun) throw new Error('Duplicate --dry-run');
      dryRun = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown Pages release argument: ${flag}`);
    if (Object.hasOwn(values, flag)) throw new Error(`Duplicate Pages release argument: ${flag}`);
    const value = String(args[index + 1] || '').trim();
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values[flag] = value;
    index += 1;
  }
  return {
    environment: values['--environment'],
    manifestPath: values['--manifest'],
    d1MigrationManifestPath: values['--d1-migration-manifest'],
    expectedCommit: values['--expected-commit'],
    confirmProject: values['--confirm-project'],
    confirmBranch: values['--confirm-branch'],
    confirmDeploy: values['--confirm-deploy'],
    previewAcceptancePath: values['--preview-acceptance'],
    previewManifestPath: values['--preview-manifest'],
    previewD1MigrationManifestPath: values['--preview-d1-migration-manifest'],
    dryRun,
  };
}

export function buildPagesDeployInvocation({ root, plan }) {
  const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  return {
    command: process.execPath,
    args: [
      wrangler,
      'pages',
      'deploy',
      'dist',
      '--project-name', PAGES_PROJECT,
      '--branch', plan.branch,
      '--commit-hash', plan.commit,
      '--commit-dirty=false',
    ],
  };
}

export function runPagesDeploy({ invocation, dryRun, spawn = spawnSync, root }) {
  if (dryRun) return { spawned: false, invocation };
  const result = spawn(invocation.command, invocation.args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Wrangler Pages deploy failed with exit code ${result.status}`);
  return { spawned: true, invocation };
}

export function main(args = process.argv.slice(2), root = process.cwd()) {
  const options = parsePagesReleaseArgs(args);
  if (!PAGES_TARGETS[options.environment]) {
    throw new Error('Pages release requires --environment preview|production');
  }
  if (!options.manifestPath) throw new Error('Pages release requires --manifest under tmp/releases');
  if (!options.d1MigrationManifestPath) {
    throw new Error('Pages release requires --d1-migration-manifest under tmp/releases');
  }
  if (options.environment === 'production' && !options.previewAcceptancePath) {
    throw new Error('Production Pages release requires --preview-acceptance under tmp/releases');
  }
  if (options.environment === 'production' && !options.previewManifestPath) {
    throw new Error('Production Pages release requires --preview-manifest under tmp/releases');
  }
  if (options.environment === 'production' && !options.previewD1MigrationManifestPath) {
    throw new Error('Production Pages release requires --preview-d1-migration-manifest');
  }
  if (options.environment === 'preview' && (
    options.previewAcceptancePath
    || options.previewManifestPath
    || options.previewD1MigrationManifestPath
  )) {
    throw new Error('Preview acceptance/build/D1 evidence flags are only valid for production');
  }

  const context = readPagesReleaseContext({
    root,
    environment: options.environment,
    manifestPath: options.manifestPath,
    d1MigrationManifestPath: options.d1MigrationManifestPath,
    previewAcceptancePath: options.previewAcceptancePath,
    previewManifestPath: options.previewManifestPath,
    previewD1MigrationManifestPath: options.previewD1MigrationManifestPath,
  });
  const plan = validatePagesDeployGuard({ ...options, ...context });
  const invocation = buildPagesDeployInvocation({ root, plan });
  const result = runPagesDeploy({ invocation, dryRun: options.dryRun, root });
  if (options.dryRun) {
    console.log(JSON.stringify({ mode: 'dry-run', spawned: false, plan, command: invocation.args.slice(1) }, null, 2));
  } else {
    console.log(`Pages ${plan.environment} deployed from verified bundle ${plan.bundleSha256}`);
  }
  return result;
}

const isEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) main();
