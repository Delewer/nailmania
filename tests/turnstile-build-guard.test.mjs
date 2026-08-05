import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import viteConfig from '../vite.config.js';
import {
  assertCloudflarePagesTurnstileBuild,
  assertTurnstileBuildSiteKey,
  CLOUDFLARE_PAGES_BRANCH_ENVIRONMENTS,
  TURNSTILE_SITE_KEY_SHA256,
} from '../scripts/turnstile-build-guard.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const previewKey = `0x4${'P'.repeat(20)}`;
const productionKey = `0x4${'R'.repeat(20)}`;
const fixtureFingerprints = Object.freeze({
  preview: sha256(previewKey),
  production: sha256(productionKey),
});

test('Turnstile site-key fingerprints and reviewed Pages branches stay environment-specific', () => {
  assert.deepEqual(CLOUDFLARE_PAGES_BRANCH_ENVIRONMENTS, {
    'd1-preview-bootstrap': 'preview',
    main: 'production',
  });
  assert.deepEqual(TURNSTILE_SITE_KEY_SHA256, {
    preview: '0f44a961818ff168edaaeef99497e5a18e2014f855d89bbb368715fc9ed664b1',
    production: '889be277aae2253094dbe7876f00988da0be175e8935303718da37300ac946b1',
  });
  assert.notEqual(TURNSTILE_SITE_KEY_SHA256.preview, TURNSTILE_SITE_KEY_SHA256.production);
});

test('Turnstile build guard accepts only the pinned key for the selected environment', () => {
  assert.deepEqual(
    assertTurnstileBuildSiteKey('preview', previewKey, fixtureFingerprints),
    { environment: 'preview', siteKey: previewKey, siteKeySha256: fixtureFingerprints.preview },
  );
  assert.deepEqual(
    assertTurnstileBuildSiteKey('production', productionKey, fixtureFingerprints),
    { environment: 'production', siteKey: productionKey, siteKeySha256: fixtureFingerprints.production },
  );
  assert.throws(
    () => assertTurnstileBuildSiteKey('production', previewKey, fixtureFingerprints),
    /does not match the pinned production Turnstile widget/,
  );
  assert.throws(
    () => assertTurnstileBuildSiteKey('preview', productionKey, fixtureFingerprints),
    /does not match the pinned preview Turnstile widget/,
  );
  assert.throws(
    () => assertTurnstileBuildSiteKey('production', '', fixtureFingerprints),
    /requires a production-format VITE_TURNSTILE_SITE_KEY/,
  );
  assert.throws(
    () => assertTurnstileBuildSiteKey('production', '1x00000000000000000000AA', fixtureFingerprints),
    /Cloudflare test keys are refused/,
  );
});

test('Cloudflare Pages build guard maps exact branches and rejects unreviewed deployments', () => {
  assert.equal(assertCloudflarePagesTurnstileBuild({}, fixtureFingerprints), null);
  assert.equal(
    assertCloudflarePagesTurnstileBuild({
      CF_PAGES: '1',
      CF_PAGES_BRANCH: 'main',
      VITE_TURNSTILE_SITE_KEY: productionKey,
    }, fixtureFingerprints)?.environment,
    'production',
  );
  assert.equal(
    assertCloudflarePagesTurnstileBuild({
      CF_PAGES: '1',
      CF_PAGES_BRANCH: 'd1-preview-bootstrap',
      VITE_TURNSTILE_SITE_KEY: previewKey,
    }, fixtureFingerprints)?.environment,
    'preview',
  );
  assert.throws(
    () => assertCloudflarePagesTurnstileBuild({
      CF_PAGES: '1',
      CF_PAGES_BRANCH: 'main',
      VITE_TURNSTILE_SITE_KEY: previewKey,
    }, fixtureFingerprints),
    /does not match the pinned production Turnstile widget/,
  );
  assert.throws(
    () => assertCloudflarePagesTurnstileBuild({
      CF_PAGES: '1',
      CF_PAGES_BRANCH: 'feature/unreviewed',
      VITE_TURNSTILE_SITE_KEY: previewKey,
    }, fixtureFingerprints),
    /refuses unreviewed branch/,
  );
});

test('Vite Cloudflare Pages build path fails before compiling when the site key is missing', () => {
  const original = {
    CF_PAGES: process.env.CF_PAGES,
    CF_PAGES_BRANCH: process.env.CF_PAGES_BRANCH,
    VITE_TURNSTILE_SITE_KEY: process.env.VITE_TURNSTILE_SITE_KEY,
  };
  try {
    process.env.CF_PAGES = '1';
    process.env.CF_PAGES_BRANCH = 'main';
    delete process.env.VITE_TURNSTILE_SITE_KEY;
    assert.throws(
      () => viteConfig({ command: 'build', mode: 'production' }),
      /requires a production-format VITE_TURNSTILE_SITE_KEY/,
    );
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
