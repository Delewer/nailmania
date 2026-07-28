import assert from 'node:assert/strict';
import test from 'node:test';

import { ORDER_ENDPOINT, OrderRequestError, submitOrderRequest } from '../src/order-api.js';
import {
  completeOrderAttemptKey,
  getOrCreateOrderAttemptKey,
  ORDER_ATTEMPT_STORAGE_KEY,
  purgeLegacyGuestOrderHistory,
  startNewOrderAttemptKey,
} from '../src/order-attempt.js';
import { createOrderQuote } from '../shared/order-quote.js';
import { onRequest as disabledLegacyOrderEndpoint } from '../functions/api/order.js';

const request = {
  items: [{ productKey: 'sku-1', quantity: 2 }],
  customer: { name: 'Ana', phone: '060000000' },
  delivery: 'pickup',
  payment: 'cash',
  lang: 'ro',
  idempotencyKey: '62d5c5ad-6171-4b68-b06a-92da07b8887d',
  expectedQuote: createOrderQuote({
    items: [{ productKey: 'sku-1', quantity: 2, unitPrice: 50, listPrice: 50, lineTotal: 100 }],
    itemsSubtotal: 100, catalogDiscount: 0, deliveryFee: 0,
    promoCode: null, promoDiscount: 0, totalAmount: 100,
  }),
};

test('checkout submits only the server-authoritative order request', async () => {
  const calls = [];
  const expectedOrder = { id: 'order-1', no: 'NM1', items: [], total: 100 };
  const fetchImpl = async (...args) => {
    calls.push(args);
    return Response.json({ ok: true, order: expectedOrder }, { status: 201 });
  };

  const order = await submitOrderRequest(request, fetchImpl);

  assert.deepEqual(order, expectedOrder);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], ORDER_ENDPOINT);
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers['Idempotency-Key'], request.idempotencyKey);
  assert.deepEqual(JSON.parse(calls[0][1].body), request);
});

test('checkout attempt key survives a lost response and is cleared only after success', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const generated = 'b1691c59-41c5-4377-a490-7292fe3d3972';
  const first = getOrCreateOrderAttemptKey({ storage, randomUUID: () => generated });
  const retry = getOrCreateOrderAttemptKey({ storage, randomUUID: () => crypto.randomUUID() });
  assert.equal(first, generated);
  assert.equal(retry, generated);
  assert.equal(values.get(ORDER_ATTEMPT_STORAGE_KEY), generated);
  completeOrderAttemptKey(generated, { storage });
  assert.equal(values.has(ORDER_ATTEMPT_STORAGE_KEY), false);
});

test('a new checkout attempt replaces a conflicted key only after an explicit client action', () => {
  const values = new Map([[ORDER_ATTEMPT_STORAGE_KEY, 'b1691c59-41c5-4377-a490-7292fe3d3972']]);
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  const replacement = '8fd23020-e035-4a33-aabc-3d7bc33ca49c';
  const result = startNewOrderAttemptKey({ storage, randomUUID: () => replacement });
  assert.equal(result, replacement);
  assert.equal(values.get(ORDER_ATTEMPT_STORAGE_KEY), replacement);
});

test('legacy guest order history is purged without removing the retry key', () => {
  const values = new Map([
    ['nm_orders', JSON.stringify([{ customer: { phone: '+37360000000' } }])],
    [ORDER_ATTEMPT_STORAGE_KEY, 'b1691c59-41c5-4377-a490-7292fe3d3972'],
  ]);
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };

  purgeLegacyGuestOrderHistory({ storage });

  assert.equal(values.has('nm_orders'), false);
  assert.equal(values.get(ORDER_ATTEMPT_STORAGE_KEY), 'b1691c59-41c5-4377-a490-7292fe3d3972');
});

test('missing D1 API fails without falling back to legacy /api/order', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return new Response('<!doctype html><title>Not found</title>', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    });
  };

  await assert.rejects(
    submitOrderRequest(request, fetchImpl),
    (error) => error instanceof OrderRequestError
      && error.code === 'ORDER_API_UNAVAILABLE'
      && error.status === 404,
  );
  assert.deepEqual(urls, [ORDER_ENDPOINT]);
});

test('structured API failures keep their code and details for checkout UX', async () => {
  const fetchImpl = async () => Response.json({
    ok: false,
    error: {
      code: 'INSUFFICIENT_STOCK',
      message: 'Stock changed',
      details: { productKey: 'sku-1', available: 1 },
    },
  }, { status: 409 });

  await assert.rejects(
    submitOrderRequest(request, fetchImpl),
    (error) => error instanceof OrderRequestError
      && error.code === 'INSUFFICIENT_STOCK'
      && error.status === 409
      && error.details.available === 1,
  );
});

test('legacy Pages order endpoint is an explicit 410 tombstone', async () => {
  const response = disabledLegacyOrderEndpoint();
  const body = await response.json();

  assert.equal(response.status, 410);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'LEGACY_ORDER_ENDPOINT_DISABLED');
});
