import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLocalMutationSafety,
  buildThresholdCart,
  isLoopbackBaseUrl,
  parseArguments,
} from '../scripts/acceptance-local.mjs';

test('local acceptance mutation safety accepts only exact loopback origins', () => {
  assert.equal(isLoopbackBaseUrl('http://127.0.0.1:8788'), true);
  assert.equal(isLoopbackBaseUrl('http://localhost:8788/'), true);
  assert.equal(isLoopbackBaseUrl('https://[::1]:8788'), true);
  assert.equal(isLoopbackBaseUrl('https://nailmania.md'), false);
  assert.equal(isLoopbackBaseUrl('https://127.0.0.1.evil.example'), false);
  assert.equal(isLoopbackBaseUrl('ftp://127.0.0.1:8788'), false);
  assert.equal(isLoopbackBaseUrl('http://user:secret@127.0.0.1:8788'), false);
  assert.equal(isLoopbackBaseUrl('http://127.0.0.1:8788/api'), false);
  assert.equal(isLoopbackBaseUrl('not-a-url'), false);

  assert.throws(
    () => assertLocalMutationSafety('https://nailmania.md', true),
    /restricted to an exact localhost/,
  );
  assert.throws(
    () => assertLocalMutationSafety('http://127.0.0.1:8788', false),
    /requires --confirm-local-mutations/,
  );
  assert.equal(
    assertLocalMutationSafety('http://127.0.0.1:8788', true).origin,
    'http://127.0.0.1:8788',
  );
});

test('threshold cart uses authoritative price and stock within order limits', () => {
  const cart = buildThresholdCart([
    { id: 1, key: 'OVER', price: 2300, stock: 1 },
    { id: 2, key: 'EXACT', price: 1100, old: 1200, stock: 2 },
    { id: 3, key: 'LOW', price: 40, stock: 99 },
  ]);
  assert.equal(cart.subtotal, 2200);
  assert.equal(cart.totalQuantity, 2);
  assert.deepEqual(cart.items, [{
    productId: 2,
    productKey: 'EXACT',
    unitPrice: 1100,
    listPrice: 1200,
    quantity: 2,
  }]);

  assert.throws(
    () => buildThresholdCart([{ key: 'LOW', price: 10, stock: 99 }]),
    /cannot build a 2200 lei cart/,
  );
});

test('local acceptance arguments require explicit flags and reject positionals', () => {
  const args = parseArguments([
    '--base-url', 'http://127.0.0.1:8788',
    '--confirm-local-mutations',
    '--report-file', 'tmp/reports/local-acceptance.json',
  ]);
  assert.equal(args.get('--base-url'), 'http://127.0.0.1:8788');
  assert.equal(args.get('--confirm-local-mutations'), true);
  assert.equal(args.get('--report-file'), 'tmp/reports/local-acceptance.json');
  assert.throws(() => parseArguments(['unexpected']), /Unknown positional argument/);
});
