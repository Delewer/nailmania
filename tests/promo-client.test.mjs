import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PromoRequestError, validatePromoRequest } from '../src/promo-api.js';

test('promo client sends only code and cart identity and returns server totals', async () => {
  let captured;
  const promo = await validatePromoRequest({
    code: 'SAVE20',
    items: [{ productKey: 'SKU-1', quantity: 2 }],
  }, async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      ok: true,
      promo: { code: 'SAVE20', merchandiseSubtotal: 400, discountAmount: 80, merchandiseTotalAfterPromo: 320 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(captured.url, '/api/promos/validate');
  assert.equal(captured.options.credentials, 'same-origin');
  assert.deepEqual(captured.body, { code: 'SAVE20', items: [{ productKey: 'SKU-1', quantity: 2 }] });
  assert.equal(promo.discountAmount, 80);
  assert.equal(promo.merchandiseSubtotal, 400);
});

test('promo client preserves structured server rejection codes', async () => {
  await assert.rejects(
    validatePromoRequest({ code: 'USED', items: [{ productKey: 'SKU-1', quantity: 1 }] }, async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'PROMO_TOTAL_LIMIT_REACHED', message: 'Limit reached', details: { limit: 1 } },
    }), { status: 409, headers: { 'content-type': 'application/json' } })),
    (error) => error instanceof PromoRequestError
      && error.code === 'PROMO_TOTAL_LIMIT_REACHED'
      && error.status === 409
      && error.details.limit === 1,
  );
});

test('checkout forwards only the applied promo and Turnstile order token to server order creation', () => {
  const checkout = readFileSync(new URL('../src/pages/Checkout.jsx', import.meta.url), 'utf8');
  const shop = readFileSync(new URL('../src/shop.jsx', import.meta.url), 'utf8');
  assert.match(checkout, /validatePromoRequest/);
  assert.match(checkout, /TurnstileWidget action="order"/);
  assert.match(checkout, /promoServerPrice/);
  assert.match(shop, /promoCode:details\.promoCode/);
  assert.match(shop, /turnstileToken:details\.turnstileToken/);
});
