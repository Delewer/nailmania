import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readPagesReleaseContext,
  validatePreviewAcceptanceRecord,
} from './pages-release-guard.mjs';

const VALUE_FLAGS = new Set([
  '--manifest',
  '--d1-migration-manifest',
  '--d1-catalog-manifest',
  '--expected-commit',
  '--preview-url',
  '--confirm-url',
  '--confirm-acceptance',
]);

export function parsePreviewAcceptanceArgs(args) {
  const values = {};
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--dry-run') {
      if (dryRun) throw new Error('Duplicate --dry-run');
      dryRun = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown preview acceptance argument: ${flag}`);
    if (Object.hasOwn(values, flag)) throw new Error(`Duplicate preview acceptance argument: ${flag}`);
    const value = String(args[index + 1] || '').trim();
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values[flag] = value;
    index += 1;
  }
  return {
    manifestPath: values['--manifest'],
    d1MigrationManifestPath: values['--d1-migration-manifest'],
    d1CatalogManifestPath: values['--d1-catalog-manifest'],
    expectedCommit: values['--expected-commit'],
    previewUrl: values['--preview-url'],
    confirmUrl: values['--confirm-url'],
    confirmAcceptance: values['--confirm-acceptance'],
    dryRun,
  };
}

export function main(args = process.argv.slice(2), root = process.cwd(), nowMs = Date.now()) {
  const options = parsePreviewAcceptanceArgs(args);
  if (!options.manifestPath) throw new Error('Preview acceptance requires --manifest under tmp/releases');
  if (!options.d1MigrationManifestPath || !options.d1CatalogManifestPath) {
    throw new Error(
      'Preview acceptance requires --d1-migration-manifest and --d1-catalog-manifest under tmp/releases',
    );
  }
  const context = readPagesReleaseContext({
    root,
    environment: 'preview',
    manifestPath: options.manifestPath,
    d1MigrationManifestPath: options.d1MigrationManifestPath,
    d1CatalogManifestPath: options.d1CatalogManifestPath,
  });
  const evidence = validatePreviewAcceptanceRecord({ ...options, ...context, nowMs });
  if (options.dryRun) {
    console.log(JSON.stringify({ mode: 'dry-run', written: false, evidence }, null, 2));
    return { written: false, evidence };
  }

  const releasesDirectory = path.join(root, 'tmp', 'releases');
  mkdirSync(releasesDirectory, { recursive: true });
  const stamp = evidence.acceptedAt.replace(/[:.]/g, '-');
  const output = path.join(releasesDirectory, `preview-acceptance-${stamp}.json`);
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`Preview acceptance recorded: ${path.relative(root, output)}`);
  return { written: true, evidence, output };
}

const isEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntrypoint) main();
