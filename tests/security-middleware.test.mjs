import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isKnownSpaRoute, isNoindexSpaRoute, onRequest } from '../functions/_middleware.js';

test('Pages middleware adds a fresh request ID and production security headers', async () => {
  const data = {};
  const response = await onRequest({
    request: new Request('https://nailmania.md/api/products'),
    env: { ENVIRONMENT: 'production' },
    data,
    next: async () => new Response('ok', { headers: { 'cache-control': 'public, max-age=30' } }),
  });

  assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/i);
  assert.equal(data.requestId, response.headers.get('x-request-id'));
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /font-src 'self' data: https:\/\/fonts\.gstatic\.com/);
  assert.match(csp, /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
  assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=30');
  assert.equal(await response.text(), 'ok');
});

test('Pages middleware returns a generic request-correlated JSON error', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await onRequest({
      request: new Request('http://127.0.0.1:8788/api/orders', { method: 'POST' }),
      env: { ENVIRONMENT: 'local' },
      data: {},
      next: async () => { throw new Error('database details must stay private'); },
    });
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.equal(response.headers.get('strict-transport-security'), null);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.message, 'Internal server error');
    assert.equal(body.error.requestId, response.headers.get('x-request-id'));
    assert.doesNotMatch(JSON.stringify(body), /database details/);
  } finally {
    console.error = originalError;
  }
});

test('Pages middleware puts the request ID into handled API errors', async () => {
  const response = await onRequest({
    request: new Request('https://nailmania.md/api/orders', { method: 'POST' }),
    env: { ENVIRONMENT: 'local' },
    data: {},
    next: async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'INSUFFICIENT_STOCK', message: 'No stock' },
    }), {
      status: 409,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  });
  const body = await response.json();

  assert.equal(body.error.requestId, response.headers.get('x-request-id'));
  assert.equal(body.error.code, 'INSUFFICIENT_STOCK');
});

test('Pages middleware returns a server-side noindex 404 for unknown SPA routes', async () => {
  const shell = `<!doctype html><head><!-- SEO:START --><title>Home</title><meta name="robots" content="index,follow"/><script id="seo-jsonld" type="application/ld+json">{"@type":"Store"}</script><!-- SEO:END --></head><body><div id="root"></div></body>`;
  const unknown = await onRequest({
    request: new Request('https://nailmania.md/does-not-exist'),
    env: { ENVIRONMENT: 'production' },
    data: {},
    next: async () => new Response(shell, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  });
  const body = await unknown.text();

  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get('cache-control'), 'no-store');
  assert.match(body, /<title>Pagină negăsită \| Nail Mania<\/title>/);
  assert.match(body, /content="noindex,follow"/);
  assert.doesNotMatch(body, /"@type":"Store"|content="index,follow"/);
  for (const pathname of ['/', '/login', '/account/orders/order-id', '/product/T0001', '/admin/products']) {
    assert.equal(isKnownSpaRoute(pathname), true, pathname);
  }
  for (const pathname of ['/login', '/account/orders/order-id', '/admin/products']) {
    assert.equal(isNoindexSpaRoute(pathname), true, pathname);
  }
  assert.equal(isNoindexSpaRoute('/product/T0001'), false);
  assert.equal(isKnownSpaRoute('/account/orders/order-id/extra'), false);

  const known = await onRequest({
    request: new Request('https://nailmania.md/login'),
    env: { ENVIRONMENT: 'production' },
    data: {},
    next: async () => new Response(shell, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  });
  assert.equal(known.status, 200);
  assert.equal(known.headers.get('cache-control'), 'no-store');
  assert.match(await known.text(), /<title>Autentificare \| Nail Mania<\/title>[\s\S]*content="noindex,nofollow"/);
});

test('HTML uses a self-hosted recovery module and keeps only JSON-LD as an inline data block', () => {
  const source = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(source, /<script type="module" src="\/src\/asset-recovery\.js"><\/script>/);
  const inlineScripts = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => match[2].trim());
  assert.equal(inlineScripts.length, 1);
  assert.match(inlineScripts[0][1], /type="application\/ld\+json"/);
  assert.doesNotMatch(source, /<script>\s*\(function/);
});
