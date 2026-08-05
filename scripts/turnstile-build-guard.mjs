import { createHash } from 'node:crypto';

export const TURNSTILE_SITE_KEY_SHA256 = Object.freeze({
  preview: '0f44a961818ff168edaaeef99497e5a18e2014f855d89bbb368715fc9ed664b1',
  production: '889be277aae2253094dbe7876f00988da0be175e8935303718da37300ac946b1',
});

export const CLOUDFLARE_PAGES_BRANCH_ENVIRONMENTS = Object.freeze({
  'd1-preview-bootstrap': 'preview',
  main: 'production',
});

const PRODUCTION_SITE_KEY = /^0x[A-Za-z0-9_-]{10,100}$/;

export function assertTurnstileBuildSiteKey(
  environment,
  configuredKey,
  expectedFingerprints = TURNSTILE_SITE_KEY_SHA256,
) {
  if (!Object.hasOwn(TURNSTILE_SITE_KEY_SHA256, environment)) {
    throw new Error('Turnstile build guard requires environment preview|production');
  }

  const siteKey = String(configuredKey || '').trim();
  if (!PRODUCTION_SITE_KEY.test(siteKey)) {
    throw new Error(
      'Release build requires a production-format VITE_TURNSTILE_SITE_KEY; empty and Cloudflare test keys are refused',
    );
  }

  const siteKeySha256 = createHash('sha256').update(siteKey).digest('hex');
  if (siteKeySha256 !== expectedFingerprints[environment]) {
    throw new Error(
      `VITE_TURNSTILE_SITE_KEY does not match the pinned ${environment} Turnstile widget`,
    );
  }
  return { environment, siteKey, siteKeySha256 };
}

export function assertCloudflarePagesTurnstileBuild(
  environmentVariables = process.env,
  expectedFingerprints = TURNSTILE_SITE_KEY_SHA256,
) {
  if (String(environmentVariables.CF_PAGES || '') !== '1') return null;

  const branch = String(environmentVariables.CF_PAGES_BRANCH || '').trim();
  const environment = CLOUDFLARE_PAGES_BRANCH_ENVIRONMENTS[branch];
  if (!environment) {
    throw new Error(`Cloudflare Pages build refuses unreviewed branch: ${branch || '(missing)'}`);
  }
  return assertTurnstileBuildSiteKey(
    environment,
    environmentVariables.VITE_TURNSTILE_SITE_KEY,
    expectedFingerprints,
  );
}
