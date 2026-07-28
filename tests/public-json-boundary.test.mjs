import assert from 'node:assert/strict';
import test from 'node:test';

import { readCustomerJson } from '../functions/_lib/customer-http.js';
import { readBoundedJson } from '../functions/_lib/http.js';
import { onRequestPost as createOrder } from '../functions/api/orders.js';
import { onRequestPost as validatePromo } from '../functions/api/promos/validate.js';

const encoder = new TextEncoder();

function chunkedJsonRequest(url, raw, { chunkBytes = 1024 } = {}) {
  const bytes = encoder.encode(raw);
  let offset = 0;
  const state = { cancelled: false };
  const body = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const nextOffset = Math.min(offset + chunkBytes, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, nextOffset));
      offset = nextOffset;
    },
    cancel() { state.cancelled = true; },
  });
  const request = new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      origin: new URL(url).origin,
      'sec-fetch-site': 'same-origin',
    },
    body,
    duplex: 'half',
  });
  assert.equal(request.headers.has('content-length'), false);
  return { request, state };
}

function poisonRequest(url, {
  origin = new URL(url).origin,
  fetchSite = 'same-origin',
  contentType = 'application/json',
  contentLength,
} = {}) {
  const state = { bodyReads: 0 };
  const headers = new Headers({
    origin,
    'sec-fetch-site': fetchSite,
    'content-type': contentType,
  });
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));
  return {
    state,
    request: {
      url,
      headers,
      body: {
        getReader() {
          state.bodyReads += 1;
          throw new Error('body must not be read');
        },
      },
    },
  };
}

async function responseError(response) {
  const payload = await response.json();
  return payload.error;
}

test('bounded JSON reader enforces byte limits without trusting Content-Length', async () => {
  const streamed = chunkedJsonRequest(
    'https://shop.test/api/test',
    JSON.stringify({ padding: 'x'.repeat(2048) }),
    { chunkBytes: 600 },
  );
  await assert.rejects(
    readBoundedJson(streamed.request, { maxBytes: 1024 }),
    (error) => error.code === 'REQUEST_BODY_TOO_LARGE' && error.status === 413,
  );
  assert.equal(streamed.state.cancelled, true);

  const declared = poisonRequest('https://shop.test/api/test', { contentLength: 1025 });
  await assert.rejects(
    readBoundedJson(declared.request, { maxBytes: 1024 }),
    (error) => error.code === 'REQUEST_BODY_TOO_LARGE' && error.status === 413,
  );
  assert.equal(declared.state.bodyReads, 0);
});

test('public JSON boundaries require the exact application/json media type before reading', async () => {
  const accepted = await readBoundedJson(new Request('https://shop.test/api/test', {
    method: 'POST',
    headers: { 'content-type': 'Application/JSON ; charset=UTF-8' },
    body: '{"ok":true}',
  }), { maxBytes: 1024 });
  assert.deepEqual(accepted, { ok: true });

  const order = poisonRequest('https://shop.test/api/orders', { contentType: 'application/jsonp' });
  const orderResponse = await createOrder({
    request: order.request,
    env: { ENVIRONMENT: 'production' },
  });
  assert.equal(orderResponse.status, 415);
  assert.equal((await responseError(orderResponse)).code, 'JSON_REQUIRED');
  assert.equal(order.state.bodyReads, 0);

  const promo = poisonRequest('https://shop.test/api/promos/validate', { contentType: 'text/json' });
  const promoResponse = await validatePromo({
    request: promo.request,
    env: { ENVIRONMENT: 'production' },
  });
  assert.equal(promoResponse.status, 415);
  assert.equal((await responseError(promoResponse)).code, 'JSON_REQUIRED');
  assert.equal(promo.state.bodyReads, 0);
});

test('orders and guest promo validation reject cross-origin requests before reading a body', async () => {
  const endpoints = [
    ['https://shop.test/api/orders', createOrder],
    ['https://shop.test/api/promos/validate', validatePromo],
  ];
  for (const [url, endpoint] of endpoints) {
    const input = poisonRequest(url, {
      origin: 'https://evil.test',
      fetchSite: 'cross-site',
    });
    const response = await endpoint({
      request: input.request,
      env: { ENVIRONMENT: 'production' },
    });
    assert.equal(response.status, 403);
    assert.equal((await responseError(response)).code, 'CROSS_ORIGIN_REQUEST');
    assert.equal(input.state.bodyReads, 0);
  }
});

test('orders, customer mutations and promo validation cap streamed bodies', async () => {
  const oversized = JSON.stringify({ padding: 'x'.repeat(70 * 1024) });

  const order = chunkedJsonRequest('https://shop.test/api/orders', oversized);
  const orderResponse = await createOrder({
    request: order.request,
    env: { ENVIRONMENT: 'production' },
  });
  assert.equal(orderResponse.status, 413);
  assert.equal((await responseError(orderResponse)).code, 'REQUEST_BODY_TOO_LARGE');

  const customer = chunkedJsonRequest('https://shop.test/api/auth/login', oversized);
  await assert.rejects(
    readCustomerJson(customer.request),
    (error) => error.code === 'REQUEST_BODY_TOO_LARGE' && error.status === 413,
  );

  const promo = chunkedJsonRequest('https://shop.test/api/promos/validate', oversized);
  const promoResponse = await validatePromo({
    request: promo.request,
    env: { ENVIRONMENT: 'production' },
  });
  assert.equal(promoResponse.status, 413);
  assert.equal((await responseError(promoResponse)).code, 'REQUEST_BODY_TOO_LARGE');
});
