import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTurnstile } from '../functions/_lib/turnstile.js';

const request = new Request('https://nailmania.md/api/auth/login', {
  method: 'POST',
  headers: { 'cf-connecting-ip': '203.0.113.7' },
});

test('Turnstile may be bypassed only by an explicitly local environment', async () => {
  assert.deepEqual(await verifyTurnstile({ request, env: { ENVIRONMENT: 'local' }, token: '', action: 'login' }), {
    success: true,
    bypassed: true,
  });
  await assert.rejects(
    verifyTurnstile({ request, env: { ENVIRONMENT: 'preview' }, token: 'token', action: 'login' }),
    (error) => error.code === 'HUMAN_VERIFICATION_NOT_CONFIGURED' && error.status === 503,
  );
});

test('Turnstile validates the server response action and hostname', async () => {
  let sent;
  const env = {
    ENVIRONMENT: 'preview',
    TURNSTILE_SECRET_KEY: 'secret-kept-server-side',
    TURNSTILE_HOSTNAMES: 'nailmania.md, preview.nailmania.pages.dev',
    TURNSTILE_FETCH: async (_url, init) => {
      sent = JSON.parse(init.body);
      return Response.json({ success: true, action: 'login', hostname: 'nailmania.md' });
    },
  };

  const result = await verifyTurnstile({ request, env, token: 'single-use-token', action: 'login' });
  assert.equal(result.success, true);
  assert.equal(sent.response, 'single-use-token');
  assert.equal(sent.remoteip, '203.0.113.7');
  assert.equal(sent.secret, 'secret-kept-server-side');
  assert.match(sent.idempotency_key, /^[0-9a-f-]{36}$/i);
});

test('Turnstile rejects a failed or cross-action token without exposing its secret', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(verifyTurnstile({
      request,
      env: {
        ENVIRONMENT: 'production',
        TURNSTILE_SECRET_KEY: 'secret',
        TURNSTILE_FETCH: async () => Response.json({ success: true, action: 'register', hostname: 'nailmania.md' }),
      },
      token: 'token',
      action: 'login',
    }), (error) => error.code === 'HUMAN_VERIFICATION_FAILED' && error.status === 403);
  } finally {
    console.warn = originalWarn;
  }
});

test('Turnstile fails closed when the expected action or request hostname is absent', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  const base = {
    ENVIRONMENT: 'production',
    TURNSTILE_SECRET_KEY: 'secret',
  };
  try {
    await assert.rejects(verifyTurnstile({
      request,
      env: {
        ...base,
        TURNSTILE_FETCH: async () => Response.json({ success: true, hostname: 'nailmania.md' }),
      },
      token: 'token',
      action: 'login',
    }), (error) => error.code === 'HUMAN_VERIFICATION_FAILED');

    await assert.rejects(verifyTurnstile({
      request,
      env: {
        ...base,
        TURNSTILE_FETCH: async () => Response.json({ success: true, action: 'login', hostname: 'attacker.example' }),
      },
      token: 'token',
      action: 'login',
    }), (error) => error.code === 'HUMAN_VERIFICATION_FAILED');
  } finally {
    console.warn = originalWarn;
  }
});
