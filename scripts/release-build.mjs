import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { assertCanonicalCatalogImagesForRelease } from './catalog-image-policy.mjs';
import { releaseBundleDigest } from './release-bundle.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? String(args[index + 1] || '').trim() : '';
};
const environment = valueAfter('--environment');
if (!['preview', 'production'].includes(environment)) {
  throw new Error('Release build requires --environment preview|production');
}

const VITE_PUBLIC_INPUT_NAMES = ['VITE_TURNSTILE_SITE_KEY'];
const allowedViteInputs = new Set(VITE_PUBLIC_INPUT_NAMES);
const unexpectedProcessInputs = Object.keys(process.env)
  .filter((name) => name.startsWith('VITE_') && !allowedViteInputs.has(name))
  .sort();
if (unexpectedProcessInputs.length) {
  throw new Error(`Release build refuses unreviewed public Vite inputs: ${unexpectedProcessInputs.join(', ')}`);
}
for (const envFile of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  const absolute = path.join(root, envFile);
  if (!existsSync(absolute)) continue;
  const unexpectedFileInputs = readFileSync(absolute, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\uFEFF/, '').match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1] || '')
    .filter((name) => name.startsWith('VITE_') && !allowedViteInputs.has(name));
  if (unexpectedFileInputs.length) {
    throw new Error(`Release build refuses unreviewed public Vite inputs in ${envFile}: ${[...new Set(unexpectedFileInputs)].sort().join(', ')}`);
  }
}

const siteKey = String(process.env.VITE_TURNSTILE_SITE_KEY || '').trim();
if (!/^0x[A-Za-z0-9_-]{10,100}$/.test(siteKey)) {
  throw new Error(
    'Release build requires a production-format VITE_TURNSTILE_SITE_KEY; empty and Cloudflare test keys are refused',
  );
}

const buildEnvironment = { ...process.env, NODE_ENV: 'production' };
const run = (command, commandArgs, { capture = false } = {}) => {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    env: buildEnvironment,
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
const git = (...gitArgs) => run('git', gitArgs, { capture: true });
const head = git('rev-parse', 'HEAD');
if (!/^[a-f0-9]{40}$/i.test(head) || valueAfter('--expected-commit') !== head) {
  throw new Error(`Release build requires --expected-commit ${head}`);
}
if (git('status', '--porcelain')) throw new Error('Release build requires a clean Git worktree');
if (environment === 'production' && git('branch', '--show-current') !== 'main') {
  throw new Error('Production release build must run from main');
}

assertCanonicalCatalogImagesForRelease(root);
run(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);
run(process.execPath, [path.join(root, 'scripts', 'build-seo.mjs')]);

if (git('rev-parse', 'HEAD') !== head || git('status', '--porcelain')) {
  throw new Error('Release build changed tracked files or HEAD; refusing to attest the bundle');
}

const distDirectory = path.join(root, 'dist');
const { files, bundleSha256 } = releaseBundleDigest(distDirectory);
const keyBytes = Buffer.from(siteKey);
if (!files.some((file) => readFileSync(file).includes(keyBytes))) {
  throw new Error('VITE_TURNSTILE_SITE_KEY was not embedded in the release bundle');
}
const completedAt = new Date().toISOString();
const stamp = completedAt.replace(/[:.]/g, '-');
const releaseDirectory = path.join(root, 'tmp', 'releases');
mkdirSync(releaseDirectory, { recursive: true });
const manifestPath = path.join(releaseDirectory, `${environment}-pages-build-${stamp}.json`);
writeFileSync(manifestPath, `${JSON.stringify({
  environment,
  commit: head,
  completedAt,
  files: files.length,
  bundleSha256,
  turnstileSiteKeySha256: createHash('sha256').update(siteKey).digest('hex'),
  vitePublicInputContract: 1,
  vitePublicInputNames: VITE_PUBLIC_INPUT_NAMES,
}, null, 2)}\n`);
console.log(`Release Pages bundle verified for ${environment} at ${head}`);
console.log(`Manifest: ${path.relative(root, manifestPath)}`);
