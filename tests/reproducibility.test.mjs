import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertReportContainsNoSensitiveData,
  serializeJsonReport,
  writeJsonReportFile,
} from '../scripts/report-file.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:'));

test('tooling pins Node 24 and npm enforces the engine contract', () => {
  const packageConfig = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const npmConfig = readFileSync(path.join(ROOT, '.npmrc'), 'utf8');
  assert.equal(packageConfig.engines?.node, '24.x');
  assert.match(npmConfig, /^engine-strict=true\s*$/m);
  assert.equal(Number(process.versions.node.split('.')[0]), 24);
});

test('JSON reports are sensitive-data checked and atomically confined to tmp/reports', (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'nailmania-report-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const report = {
    ok: true,
    baseUrl: 'http://127.0.0.1:8788',
    order: { id: 'local-order-id', status: 'cancelled' },
    readiness: { checks: { telegramBotToken: false, customerEmailDelivery: false, customerPasswordResetUrl: false } },
  };

  const written = writeJsonReportFile('tmp/reports/nested/acceptance.json', report, { cwd });
  assert.equal(readFileSync(written.path, 'utf8'), serializeJsonReport(report));
  assert.deepEqual(readdirSync(path.dirname(written.path)), ['acceptance.json']);
  const replaced = { ...report, order: { ...report.order, status: 'verified' } };
  writeJsonReportFile('tmp/reports/nested/acceptance.json', replaced, { cwd });
  assert.equal(readFileSync(written.path, 'utf8'), serializeJsonReport(replaced));
  assert.deepEqual(readdirSync(path.dirname(written.path)), ['acceptance.json']);

  assert.throws(
    () => writeJsonReportFile('tmp/outside.json', report, { cwd }),
    /must stay under tmp\/reports/,
  );
  assert.throws(
    () => writeJsonReportFile('https://example.test/report.json', report, { cwd }),
    /local filesystem path/,
  );
  assert.throws(
    () => writeJsonReportFile('tmp/reports/report.txt', report, { cwd }),
    /must end in \.json/,
  );
  assert.throws(
    () => assertReportContainsNoSensitiveData({ adminToken: 'must-not-be-written' }),
    /sensitive field/,
  );
  assert.throws(
    () => assertReportContainsNoSensitiveData({ customer: { email: 'person@example.test' } }),
    /sensitive field/,
  );
  assert.throws(
    () => assertReportContainsNoSensitiveData({ baseUrl: 'https://example.test/?token=secret' }),
    /query or fragment/,
  );
  assert.doesNotThrow(
    () => assertReportContainsNoSensitiveData({ readiness: { checks: { customerPasswordResetUrl: true } } }),
  );
  assert.throws(
    () => assertReportContainsNoSensitiveData({ baseUrl: 123 }),
    /invalid URL/,
  );
});
