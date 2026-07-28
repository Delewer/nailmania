import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertSafeBrowserProfilePath,
  assessPageSnapshot,
  findBrowserExecutable,
  isDirectExecution,
  isExpectedFailedResponse,
  isLoopbackBaseUrl,
  isReadOnlyHttpMethod,
  normalizeLoopbackBaseUrl,
  parseArguments,
  resolveBrowserSmokePath,
} from '../scripts/browser-smoke.mjs';

test('browser smoke accepts only an exact credential-free loopback origin', () => {
  assert.equal(normalizeLoopbackBaseUrl('http://127.0.0.1:8797/'), 'http://127.0.0.1:8797');
  assert.equal(normalizeLoopbackBaseUrl('https://localhost:8797'), 'https://localhost:8797');
  assert.equal(normalizeLoopbackBaseUrl('https://[::1]:8797'), 'https://[::1]:8797');
  assert.equal(isLoopbackBaseUrl('https://nailmania.md'), false);
  assert.equal(isLoopbackBaseUrl('http://127.0.0.1.evil.example:8797'), false);
  assert.equal(isLoopbackBaseUrl('http://user:secret@127.0.0.1:8797'), false);
  assert.equal(isLoopbackBaseUrl('http://127.0.0.1:8797/path'), false);
  assert.equal(isLoopbackBaseUrl('http://127.0.0.1:8797/?key=value'), false);
  assert.equal(isLoopbackBaseUrl('ftp://127.0.0.1:8797'), false);
});

test('browser smoke CLI is explicit and rejects ambiguous input', () => {
  const args = parseArguments([
    '--base-url', 'http://127.0.0.1:8797',
    '--report-file', 'tmp/reports/browser-smoke.json',
    '--browser-path', 'C:/Browser/chrome.exe',
  ]);
  assert.equal(args.get('--base-url'), 'http://127.0.0.1:8797');
  assert.equal(args.get('--report-file'), 'tmp/reports/browser-smoke.json');
  assert.throws(() => parseArguments(['unexpected']), /Unknown positional argument/);
  assert.throws(() => parseArguments(['--base-url']), /requires a value/);
  assert.throws(
    () => parseArguments(['--base-url', 'http://localhost', '--base-url', 'http://localhost']),
    /Duplicate argument/,
  );
});

test('browser smoke blocks every method that can change server state', () => {
  assert.equal(isReadOnlyHttpMethod('GET'), true);
  assert.equal(isReadOnlyHttpMethod('head'), true);
  assert.equal(isReadOnlyHttpMethod('POST'), false);
  assert.equal(isReadOnlyHttpMethod('PATCH'), false);
  assert.equal(isReadOnlyHttpMethod('DELETE'), false);
  assert.equal(isReadOnlyHttpMethod('OPTIONS'), false);
});

test('browser executable override must resolve to a real file', () => {
  const cwd = path.resolve('tmp', 'browser-test');
  const expected = path.resolve(cwd, 'chrome.exe');
  assert.equal(findBrowserExecutable({
    explicitPath: 'chrome.exe',
    cwd,
    env: {},
    fileExists: (candidate) => candidate === expected,
  }), expected);
  assert.throws(() => findBrowserExecutable({
    explicitPath: 'missing.exe',
    cwd,
    env: {},
    fileExists: () => false,
  }), /does not exist/);
});

test('browser smoke paths cannot escape ignored output roots', () => {
  const cwd = path.resolve('tmp', 'browser-smoke-guard-test');
  const output = resolveBrowserSmokePath('run-1', { cwd });
  assert.equal(output.target, path.join(cwd, 'tmp', 'browser-smoke', 'run-1'));
  assert.throws(() => resolveBrowserSmokePath('../escape', { cwd }), /must stay below/);

  const profile = path.join(cwd, 'tmp', 'browser-smoke', 'profiles', 'profile-1');
  assert.equal(assertSafeBrowserProfilePath(profile, { cwd }), profile);
  assert.throws(
    () => assertSafeBrowserProfilePath(path.join(cwd, 'tmp', 'browser-smoke'), { cwd }),
    /unsafe browser profile/,
  );
  assert.throws(
    () => assertSafeBrowserProfilePath(path.join(cwd, 'tmp', 'browser-smoke', 'profiles', 'other'), { cwd }),
    /unsafe browser profile/,
  );
});

test('page assessment detects missing semantics and horizontal overflow', () => {
  assert.deepEqual(assessPageSnapshot({
    h1Count: 1,
    visibleControlCount: 2,
    horizontalOverflowPixels: 0,
    requirements: [
      { selector: 'h1', present: true, control: false, named: true },
      { selector: 'button', present: true, control: true, named: true },
    ],
  }), { passed: true, failures: [] });

  const failed = assessPageSnapshot({
    h1Count: 0,
    visibleControlCount: 1,
    horizontalOverflowPixels: 12,
    requirements: [{ selector: 'button', present: true, control: true, named: false }],
  });
  assert.equal(failed.passed, false);
  assert.equal(failed.failures.length, 3);
});

test('only intentional read-only failures are expected', () => {
  assert.equal(isExpectedFailedResponse({ method: 'GET', path: '/api/admin/session', status: 401 }), true);
  assert.equal(isExpectedFailedResponse({ method: 'GET', path: '/api/admin/session', status: 500 }), false);
  assert.equal(isExpectedFailedResponse({ method: 'POST', path: '/api/admin/session', status: 401 }), false);
  assert.equal(isExpectedFailedResponse({ method: 'GET', path: '/__browser-smoke-not-found__', status: 404 }), true);
  assert.equal(isExpectedFailedResponse({ method: 'POST', path: '/__browser-smoke-not-found__', status: 404 }), false);
  assert.equal(isExpectedFailedResponse({ method: 'GET', path: '/__browser-smoke-not-found__', status: 500 }), false);
  assert.equal(isExpectedFailedResponse({ method: 'GET', path: '/api/products', status: 404 }), false);
});

test('direct execution guard compares the canonical entry URL', () => {
  const entry = path.resolve('scripts', 'browser-smoke.mjs');
  assert.equal(isDirectExecution(pathToFileURL(entry).href, entry), true);
  assert.equal(isDirectExecution(pathToFileURL(`${entry}.other`).href, entry), false);
});
