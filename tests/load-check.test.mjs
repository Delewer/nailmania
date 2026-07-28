import test from 'node:test';
import assert from 'node:assert/strict';
import {
  argumentsMap,
  isSafeLocalTarget,
  normalizeLoadBaseUrl,
  percentile,
} from '../scripts/load-check.mjs';

test('load-check percentile uses nearest-rank ordering', () => {
  assert.equal(percentile([40, 10, 30, 20], 0.5), 20);
  assert.equal(percentile([40, 10, 30, 20], 0.95), 40);
  assert.equal(percentile([], 0.95), 0);
});

test('mutating order load accepts only explicit loopback targets', () => {
  assert.equal(isSafeLocalTarget('http://127.0.0.1:8788'), true);
  assert.equal(isSafeLocalTarget('http://localhost:8788'), true);
  assert.equal(isSafeLocalTarget('https://[::1]:8788'), true);
  assert.equal(isSafeLocalTarget('https://nailmania.md'), false);
  assert.equal(isSafeLocalTarget('https://127.0.0.1.evil.example'), false);
  assert.equal(isSafeLocalTarget('http://user:secret@127.0.0.1:8788'), false);
  assert.equal(isSafeLocalTarget('http://127.0.0.1:8788/path'), false);
  assert.equal(isSafeLocalTarget('not-a-url'), false);
});

test('load-check reports use an exact credential-free base origin', () => {
  assert.equal(normalizeLoadBaseUrl('https://preview.example.test/'), 'https://preview.example.test');
  assert.throws(() => normalizeLoadBaseUrl('https://user:secret@preview.example.test'), /exact HTTP\(S\) origin/);
  assert.throws(() => normalizeLoadBaseUrl('https://preview.example.test/path'), /exact HTTP\(S\) origin/);
  assert.throws(() => normalizeLoadBaseUrl('https://preview.example.test/?token=secret'), /exact HTTP\(S\) origin/);

  const args = argumentsMap(['--report-file', 'tmp/reports/catalog-load.json']);
  assert.equal(args.get('--report-file'), 'tmp/reports/catalog-load.json');
});
