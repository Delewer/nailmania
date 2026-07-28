import assert from 'node:assert/strict';
import test from 'node:test';

import { AccountApiError, accountApiRequest } from '../src/account-api.js';
import {
  OFFICIAL_TURNSTILE_TEST_SITE_KEY,
  planRepeatOrder,
  resetTokenFromHash,
  resolveTurnstileSiteKey,
  safeNextPath,
} from '../src/account-utils.js';

test('account client preserves correlated API errors and reports session expiry', async () => {
  let unauthorized = null;
  const fetchImpl = async () => Response.json({
    ok: false,
    error: { code: 'AUTH_REQUIRED', message: 'Expired', requestId: 'request-123' },
  }, { status: 401, headers: { 'x-request-id': 'header-request' } });

  await assert.rejects(
    accountApiRequest('/api/me', { fetchImpl, onUnauthorized: (error) => { unauthorized = error; } }),
    (error) => error instanceof AccountApiError
      && error.code === 'AUTH_REQUIRED'
      && error.status === 401
      && error.requestId === 'request-123',
  );
  assert.equal(unauthorized?.requestId, 'request-123');
});

test('account mutations use same-origin cookies and JSON', async () => {
  let call;
  const fetchImpl = async (...args) => {
    call = args;
    return Response.json({ ok: true, user: { id: 'customer-1' } });
  };
  await accountApiRequest('/api/auth/login', {
    method: 'POST', body: { email: 'ana@example.com' }, fetchImpl,
  });
  assert.equal(call[1].credentials, 'same-origin');
  assert.equal(call[1].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(call[1].body), { email: 'ana@example.com' });
});

test('Turnstile uses the official test key only in development or tests', () => {
  assert.deepEqual(resolveTurnstileSiteKey({ isDevelopment: true }), {
    key: OFFICIAL_TURNSTILE_TEST_SITE_KEY, isTestKey: true, configured: true,
  });
  assert.deepEqual(resolveTurnstileSiteKey({}), { key: '', isTestKey: false, configured: false });
  assert.deepEqual(resolveTurnstileSiteKey({ configuredKey: OFFICIAL_TURNSTILE_TEST_SITE_KEY }), {
    key: '', isTestKey: false, configured: false,
  });
  assert.equal(resolveTurnstileSiteKey({ configuredKey: 'production-key' }).key, 'production-key');
});

test('reset tokens stay in URL fragments and post-auth redirects remain local', () => {
  const token = 'A'.repeat(32);
  assert.equal(resetTokenFromHash(`#token=${token}`), token);
  assert.equal(resetTokenFromHash('#token=short'), '');
  assert.equal(safeNextPath('/account/orders/1?view=full'), '/account/orders/1?view=full');
  assert.equal(safeNextPath('//evil.example/path'), '/account');
  assert.equal(safeNextPath('https://evil.example/path'), '/account');
});

test('repeat-order plan uses current keys and stock without exceeding an existing cart', () => {
  const products = [
    { key: 'available', stock: 3 },
    { key: 'partial', stock: 2 },
    { key: 'sold-out', stock: 0 },
  ];
  const orderItems = [
    { productKey: 'available', quantity: 2 },
    { productKey: 'partial', quantity: 3 },
    { productKey: 'sold-out', quantity: 1 },
    { productKey: 'removed', quantity: 1 },
  ];
  const result = planRepeatOrder(orderItems, products, [{ id: 'available', q: 2 }]);

  assert.deepEqual(result.entries.map(({ product, quantity }) => [product.key, quantity]), [
    ['available', 1],
    ['partial', 2],
  ]);
  assert.deepEqual(result.adjusted, [
    { productKey: 'available', requested: 2, added: 1 },
    { productKey: 'partial', requested: 3, added: 2 },
  ]);
  assert.deepEqual(result.unavailable.map((item) => item.productKey), ['sold-out', 'removed']);
});
