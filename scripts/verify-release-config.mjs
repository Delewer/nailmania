import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { verifyMigrationManifest } from './migration-integrity.mjs';

const root = process.cwd();
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');

const pagesMiddlewarePath = 'functions/_middleware.js';
check(existsSync(path.join(root, pagesMiddlewarePath)), 'Pages middleware is missing');
const middlewareIgnoreCheck = spawnSync(
  'git',
  ['check-ignore', '--quiet', '--no-index', pagesMiddlewarePath],
  { cwd: root, encoding: 'utf8' },
);
check(
  middlewareIgnoreCheck.status === 1,
  middlewareIgnoreCheck.status === 0
    ? 'Pages middleware must not be ignored by .gitignore'
    : `Could not verify Pages middleware tracking eligibility: ${middlewareIgnoreCheck.stderr || `git exited ${middlewareIgnoreCheck.status}`}`,
);

function parseEnvironment(toml, environment) {
  const marker = new RegExp(`^\\[env\\.${environment}\\.vars\\]\\s*$`, 'm');
  const match = marker.exec(toml);
  if (!match) return null;
  const remainder = toml.slice(match.index + match[0].length);
  const nextEnvironment = /^\[env\.(?:preview|production)\.vars\]\s*$/m.exec(remainder);
  const block = nextEnvironment ? remainder.slice(0, nextEnvironment.index) : remainder;
  const value = (key) => block.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, 'm'))?.[1] || '';
  return {
    environment: value('ENVIRONMENT'),
    analyticsDatasetVariable: value('PRODUCT_ANALYTICS_DATASET'),
    analyticsDatasetBinding: block.match(new RegExp(
      `^\\[\\[env\\.${environment}\\.analytics_engine_datasets\\]\\]\\s*[\\s\\S]*?^binding\\s*=\\s*"PRODUCT_ANALYTICS"\\s*$[\\s\\S]*?^dataset\\s*=\\s*"([^"]+)"\\s*$`,
      'm',
    ))?.[1] || '',
    databaseName: value('database_name'),
    databaseId: value('database_id'),
    bucketName: value('bucket_name'),
    raw: block,
  };
}

const pagesConfig = read('wrangler.toml');
const workerConfig = JSON.parse(read('wrangler.reservations.jsonc'));
const packageConfig = JSON.parse(read('package.json'));
const compatibilityDate = pagesConfig.match(/^compatibility_date\s*=\s*"([^"]+)"\s*$/m)?.[1] || '';

check(workerConfig.workers_dev === false, 'Reservation Worker must keep workers_dev=false');
check(workerConfig.compatibility_date === compatibilityDate, 'Pages and reservation Worker compatibility dates must match');

const seenDatabaseIds = new Set();
const seenDatabaseNames = new Set();
const seenBucketNames = new Set();
const seenWorkerNames = new Set();
const seenAnalyticsDatasets = new Set();

for (const environment of ['preview', 'production']) {
  const pages = parseEnvironment(pagesConfig, environment);
  const worker = workerConfig.env?.[environment];
  const workerDatabase = worker?.d1_databases?.find(({ binding }) => binding === 'DB');
  const workerCrons = worker?.triggers?.crons || [];

  check(Boolean(pages), `Missing Pages ${environment} environment`);
  check(Boolean(worker), `Missing reservation Worker ${environment} environment`);
  if (!pages || !worker) continue;

  check(pages.environment === environment, `Pages ${environment} ENVIRONMENT must equal ${environment}`);
  check(Boolean(pages.databaseName), `Pages ${environment} D1 database_name is missing`);
  check(Boolean(pages.databaseId), `Pages ${environment} D1 database_id is missing`);
  check(!/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(pages.databaseId), `Pages ${environment} uses a placeholder D1 id`);
  check(Boolean(pages.bucketName), `Pages ${environment} R2 bucket is missing`);
  check(Boolean(pages.analyticsDatasetBinding), `Pages ${environment} PRODUCT_ANALYTICS binding is missing`);
  check(Boolean(pages.analyticsDatasetVariable), `Pages ${environment} PRODUCT_ANALYTICS_DATASET variable is missing`);
  check(
    pages.analyticsDatasetBinding === pages.analyticsDatasetVariable,
    `Pages ${environment} PRODUCT_ANALYTICS dataset and PRODUCT_ANALYTICS_DATASET do not match`,
  );
  check(!/ADMIN_DEV_(?:TOKEN|EMAIL)/.test(pages.raw), `Local admin bindings must not exist in Pages ${environment}`);

  check(workerDatabase?.database_name === pages.databaseName, `Pages/Worker ${environment} D1 names do not match`);
  check(workerDatabase?.database_id === pages.databaseId, `Pages/Worker ${environment} D1 ids do not match`);
  check(workerDatabase?.migrations_dir === 'migrations', `Worker ${environment} migrations_dir must be migrations`);
  check(workerCrons.length > 0, `Reservation Worker ${environment} cron is missing`);
  check(Boolean(worker.name), `Reservation Worker ${environment} name is missing`);

  check(!seenDatabaseNames.has(pages.databaseName), 'Preview and production must use different D1 database names');
  check(!seenDatabaseIds.has(pages.databaseId), 'Preview and production must use different D1 database ids');
  check(!seenBucketNames.has(pages.bucketName), 'Preview and production must use different R2 buckets');
  check(!seenWorkerNames.has(worker.name), 'Preview and production must use different Worker names');
  check(!seenAnalyticsDatasets.has(pages.analyticsDatasetBinding), 'Preview and production must use different Analytics Engine datasets');
  seenDatabaseNames.add(pages.databaseName);
  seenDatabaseIds.add(pages.databaseId);
  seenBucketNames.add(pages.bucketName);
  seenWorkerNames.add(worker.name);
  seenAnalyticsDatasets.add(pages.analyticsDatasetBinding);
}

check(!/^\[\[analytics_engine_datasets\]\]/m.test(pagesConfig), 'Local Pages config must not bind remote Analytics Engine');

const migrationFiles = readdirSync(path.join(root, 'migrations'))
  .filter((file) => file.endsWith('.sql'))
  .sort();
const migrationNumbers = migrationFiles.map((file) => Number(file.match(/^(\d{4})_[a-z0-9_-]+\.sql$/)?.[1]));
check(migrationFiles.length > 0, 'At least one migration is required');
check(migrationNumbers.every(Number.isInteger), 'Migration files must use NNNN_description.sql names');
migrationNumbers.forEach((number, index) => {
  check(number === index + 1, `Migration sequence must be contiguous; expected ${String(index + 1).padStart(4, '0')}`);
});
for (const file of migrationFiles) {
  check(read(`migrations/${file}`).trim().length > 0, `Migration ${file} is empty`);
}
const migrationManifestPath = 'migrations/manifest.sha256';
if (!existsSync(path.join(root, migrationManifestPath))) {
  failures.push('Migration checksum manifest is missing');
} else {
  failures.push(...verifyMigrationManifest({
    migrationFiles,
    manifestText: read(migrationManifestPath),
    readMigration: (file) => read(`migrations/${file}`),
  }));
}

const buildScript = String(packageConfig.scripts?.build || '');
check(Boolean(buildScript), 'package.json must define a build script');
check(!/\b(?:catalog|rehost|upload-r2|migrate-drive-r2)\b/i.test(buildScript), 'build must not fetch catalog data or mutate R2');
for (const environment of ['preview', 'production']) {
  check(
    new RegExp(`scripts/release-build\\.mjs\\s+--environment\\s+${environment}\\b`).test(
      String(packageConfig.scripts?.[`release:build:${environment}`] || ''),
    ),
    `release:build:${environment} must use the guarded release build wrapper`,
  );
  check(
    new RegExp(`scripts/pages-release\\.mjs\\s+--environment\\s+${environment}\\b`).test(
      String(packageConfig.scripts?.[`release:pages:${environment}`] || ''),
    ),
    `release:pages:${environment} must use the guarded Pages release wrapper`,
  );
  check(
    new RegExp(`scripts/reservations-release\\.mjs\\s+build\\s+--environment\\s+${environment}\\b`).test(
      String(packageConfig.scripts?.[`release:reservations:build:${environment}`] || ''),
    ),
    `release:reservations:build:${environment} must use the guarded Worker build wrapper`,
  );
  check(
    new RegExp(`scripts/reservations-release\\.mjs\\s+deploy\\s+--environment\\s+${environment}\\b`).test(
      String(packageConfig.scripts?.[`release:reservations:${environment}`] || ''),
    ),
    `release:reservations:${environment} must use the guarded Worker deploy wrapper`,
  );
}
check(
  /scripts\/record-preview-acceptance\.mjs\b/.test(
    String(packageConfig.scripts?.['release:pages:record-preview'] || ''),
  ),
  'release:pages:record-preview must use the guarded preview acceptance recorder',
);
for (const [name, command] of Object.entries(packageConfig.scripts || {})) {
  if (/release:d1:(?:migrate|catalog|admin):/.test(name)) {
    check(/scripts\/d1-release\.mjs\b/.test(command), `${name} must use the guarded D1 release wrapper`);
  }
  if (/\bwrangler\s+deploy\b/i.test(command)) {
    check(/--dry-run\b/i.test(command), `${name} must not deploy a Worker without --dry-run`);
  }
  check(!/\bwrangler\s+pages\s+deploy\b/i.test(command), `${name} must not deploy Pages directly`);
  check(!/\bwrangler\s+d1\b[^\n]*--remote/i.test(command), `${name} must not mutate remote D1 directly`);
}

const scriptFiles = readdirSync(path.join(root, 'scripts')).filter((file) => file.endsWith('.mjs'));
for (const file of scriptFiles) {
  if (['d1-release.mjs', 'verify-release-config.mjs'].includes(file)) continue;
  check(!/["']--remote["']/.test(read(`scripts/${file}`)), `${file} must not access remote D1 outside d1-release.mjs`);
}
for (const file of ['rehost-images.mjs', 'upload-r2.mjs', 'migrate-drive-r2.mjs']) {
  const content = read(`scripts/${file}`);
  check(/\brequireR2MutationTarget\s*\(/.test(content), `${file} must call the R2 target guard`);
  check(!/https:\/\/pub-[a-z0-9]+\.r2\.dev/i.test(content), `${file} must not hard-code an R2 public endpoint`);
}

const workflowDirectory = path.join(root, '.github', 'workflows');
const workflowFiles = readdirSync(workflowDirectory)
  .filter((file) => /\.ya?ml$/i.test(file))
  .sort();
for (const file of workflowFiles) {
  const content = read(`.github/workflows/${file}`);
  check(/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(content), `${file} must declare read-only repository permissions`);
  check(!/\b(?:pages\s+deploy|FTP-Deploy-Action|wrangler-action)\b/i.test(content), `${file} must not deploy Pages or FTP content`);
  check(!/d1\s+(?:migrations\s+apply|execute)[^\n]*--remote/i.test(content), `${file} must not mutate remote D1`);
  for (const line of content.split(/\r?\n/)) {
    if (/\bwrangler\s+deploy\b/i.test(line)) {
      check(/--dry-run\b/i.test(line), `${file} contains a Worker deploy without --dry-run`);
    }
    const action = line.match(/^\s*-?\s*uses:\s*([^\s#]+)\s*/)?.[1];
    if (action && !action.startsWith('./')) {
      const reference = action.split('@')[1] || '';
      check(/^[a-f0-9]{40}$/i.test(reference), `${file} action ${action} must be pinned to a full commit SHA`);
    }
  }
}

const readinessWorkflow = read('.github/workflows/publish.yml');
check(/preview_turnstile_site_key:\s*[\s\S]*?required:\s*true\b/.test(readinessWorkflow), 'Release readiness must require a preview Turnstile site key input');
check(/VITE_TURNSTILE_SITE_KEY:\s*\$\{\{\s*inputs\.preview_turnstile_site_key\s*\}\}/.test(readinessWorkflow), 'Release readiness must pass its Turnstile site key only through the build environment');
check(/release:build:preview\s+--\s+--expected-commit\s+\$\{\{\s*github\.sha\s*\}\}/.test(readinessWorkflow), 'Release readiness must build through the clean-SHA preview wrapper');
check(!/\bnpx\s+vite\s+build\b/.test(readinessWorkflow), 'Release readiness must not bypass the guarded Pages build');
const readinessArtifactPaths = [
  'tmp/catalog-source.csv',
  'tmp/catalog-validation.json',
  'tmp/catalog-build-integrity.json',
  'tmp/d1/catalog-import-validation.json',
  'tmp/d1/catalog-import-report.json',
  'tmp/d1/catalog-import.sql',
  'tmp/releases/preview-pages-build-*.json',
  'dist/',
];
for (const artifactPath of readinessArtifactPaths) {
  const escaped = artifactPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  check(
    new RegExp(`^\\s+${escaped}\\s*$`, 'm').test(readinessWorkflow),
    `Release readiness artifact must retain ${artifactPath}`,
  );
}
check(/if-no-files-found:\s*error\b/.test(readinessWorkflow), 'Release readiness artifact must fail when a required file is missing');
check(/include-hidden-files:\s*true\b/.test(readinessWorkflow), 'Release readiness artifact must retain hidden dist files');

const releaseBuildScript = read('scripts/release-build.mjs');
check(/VITE_TURNSTILE_SITE_KEY/.test(releaseBuildScript), 'Release build must require the Turnstile site key');
check(/Release build requires a clean Git worktree/.test(releaseBuildScript), 'Release build must enforce a clean worktree');
check(/was not embedded in the release bundle/.test(releaseBuildScript), 'Release build must verify the Turnstile key in dist');
check(/refuses unreviewed public Vite inputs/.test(releaseBuildScript), 'Release build must reject unreviewed VITE_* inputs');
check(/vitePublicInputContract/.test(releaseBuildScript), 'Release build manifest must attest its Vite public-input contract');
check(/releaseBundleDigest\s*\(/.test(releaseBuildScript), 'Release build must use the shared Pages bundle digest');

const pagesReleaseScript = read('scripts/pages-release.mjs');
const pagesReleaseGuard = read('scripts/pages-release-guard.mjs');
check(/validatePagesDeployGuard\s*\(/.test(pagesReleaseScript), 'Pages release must call its release guard');
check(/--commit-dirty=false/.test(pagesReleaseScript), 'Pages release must attest a clean commit to Wrangler');
check(/previewAcceptance/.test(pagesReleaseGuard), 'Production Pages release must require preview acceptance evidence');
check(/validateD1ReleasePair\s*\(/.test(pagesReleaseGuard), 'Pages release must bind D1 migration/catalog manifests');
check(
  /d1-preview-bootstrap\.nailmania\.pages\.dev/.test(pagesReleaseGuard),
  'Preview acceptance must be bound to the exact Pages preview origin',
);
check(/releaseBundleDigest\s*\(/.test(pagesReleaseGuard), 'Pages release must recompute the shared bundle digest');
check(/distIgnored/.test(pagesReleaseGuard), 'Pages release must verify that dist remains Git-ignored');
const d1ReleaseScript = read('scripts/d1-release.mjs');
check(
  /target\.branch/.test(d1ReleaseScript) && /--expected-commit/.test(d1ReleaseScript),
  'D1 mutations must bind both environments to an exact branch and full commit',
);
check(
  /verifyMigrationManifest\s*\(/.test(d1ReleaseScript),
  'D1 mutations must verify the migration checksum manifest in-process',
);
const reservationsReleaseScript = read('scripts/reservations-release.mjs');
const reservationsReleaseGuard = read('scripts/reservations-release-guard.mjs');
check(
  /validateReservationsDeployGuard\s*\(/.test(reservationsReleaseScript),
  'Reservations Worker release must call its deploy guard',
);
check(
  /--no-bundle/.test(reservationsReleaseGuard),
  'Reservations Worker release must deploy the exact prebuilt entrypoint without rebundling',
);
check(
  /entrypointSha256/.test(reservationsReleaseGuard)
    && /bundleSha256/.test(reservationsReleaseGuard)
    && /sourceSha256/.test(reservationsReleaseGuard),
  'Reservations Worker release must verify source, entrypoint and bundle digests',
);
check(
  /validateD1ReleaseManifest\s*\(/.test(reservationsReleaseGuard),
  'Reservations Worker deploy must require a matching D1 migration release manifest',
);
const releaseRunbook = read('docs/RELEASE.md');
check(!/\bnpx\s+wrangler\s+pages\s+deploy\b/i.test(releaseRunbook), 'Release runbook must not bypass the guarded Pages wrapper');
const rawWorkerDeployLines = releaseRunbook
  .split(/\r?\n/)
  .filter((line) => /\bnpx\s+wrangler\s+deploy\b/i.test(line) && !/--dry-run\b/i.test(line));
check(
  rawWorkerDeployLines.length === 0,
  'Release runbook must not bypass the guarded Reservations Worker wrapper',
);

const legacyPublishButton = read('docs/publish-button.gs');
check(!/UrlFetchApp\s*\.\s*fetch|PropertiesService|DEPLOY_HOOK_URL/.test(legacyPublishButton), 'Legacy Sheet button must remain a non-networking tombstone');

const secretAssignments = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'CLOUDFLARE_API_TOKEN',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'FTP_PASSWORD',
  'ADMIN_DEV_TOKEN',
  'AUTH_FINGERPRINT_SALT',
  'RATE_LIMIT_SECRET',
  'TURNSTILE_SECRET_KEY',
  'CUSTOMER_EMAIL_API_TOKEN',
  'ANALYTICS_READ_TOKEN',
  'ANALYTICS_INDEX_SECRET',
];
const publicConfiguration = [
  'wrangler.toml',
  'wrangler.local.jsonc',
  'wrangler.reservations.jsonc',
  'wrangler.reservations.local.jsonc',
  ...workflowFiles.map((file) => `.github/workflows/${file}`),
];
for (const file of publicConfiguration) {
  const content = read(file);
  for (const name of secretAssignments) {
    const assignment = new RegExp(`^\\s*${name}\\s*[:=]`, 'm');
    check(!assignment.test(content), `${file} must not assign ${name}`);
  }
}

if (failures.length) {
  console.error('Release configuration verification failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

const analyticsReaderReady = Boolean(
  String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim()
  && String(process.env.ANALYTICS_READ_TOKEN || '').trim(),
);
console.log(`Release configuration verified: ${migrationFiles.length} migrations, ${workflowFiles.length} workflow(s), isolated preview/production D1, R2 and Analytics Engine bindings; analytics reader ready=${analyticsReaderReady}.`);
