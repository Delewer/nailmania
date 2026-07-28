import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';
import { rateLimitRule } from '../functions/_lib/rate-limit.js';
import { cleanupCustomerAuthRecords } from '../functions/_lib/customer-maintenance.js';
import {
  deliverTelegramNotification,
} from '../functions/_lib/notifications.js';
import { onRequestPost as forgotPassword } from '../functions/api/auth/forgot-password.js';
import { onRequestPost as resendTelegram } from '../functions/api/admin/orders/[id]/notifications/telegram.js';
import { onRequestPatch as updateInternalComment } from '../functions/api/admin/orders/[id]/internal-comment.js';
import { onRequestGet as readiness } from '../functions/api/admin/health/readiness.js';

const schema = [
  '0001_initial.sql',
  '0002_order_transitions.sql',
  '0003_admin_products.sql',
  '0004_admin_categories.sql',
  '0005_customer_accounts.sql',
  '0006_returns_and_admin_journals.sql',
  '0007_catalog_cache.sql',
  '0008_rate_limits.sql',
  '0009_promotions.sql',
  '0010_statistics_and_analytics.sql',
  '0011_notifications_and_order_operations.sql',
].map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')).join('\n');

function setup() {
  const db = new SqliteD1(schema);
  for (const [id, email, role] of [
    ['admin-1', 'admin@example.test', 'admin'],
    ['manager-1', 'manager@example.test', 'manager'],
    ['customer-1', 'customer@example.test', 'customer'],
  ]) {
    db.sqlite.prepare(`
      INSERT INTO users (id, email, name, role, status)
      VALUES (?, ?, ?, ?, 'active')
    `).run(id, email, `${role} user`, role);
  }
  db.sqlite.prepare(`
    INSERT INTO orders (
      id, order_no, status, language, customer_name, customer_phone, customer_email,
      city, address, customer_comment, delivery_method, delivery_label,
      payment_method, payment_label, items_subtotal, catalog_discount,
      promo_discount, delivery_fee, total_amount
    ) VALUES (
      'order-1', 'NM-TEST-1', 'pending', 'ro', 'Ana Secret', '+37360000000',
      'ana@example.test', 'Chisinau', 'Strada privata 1', 'Sunati',
      'pickup', 'Ridicare', 'cash', 'Numerar', 100, 0, 0, 0, 100
    )
  `).run();
  return db;
}

const telegramOrder = {
  id: 'order-1',
  no: 'NM-TEST-1',
  customer: {
    name: 'Ana Secret', phone: '+37360000000', email: 'ana@example.test',
    city: 'Chisinau', address: 'Strada privata 1', comment: 'Sunati',
  },
  items: [],
  deliveryLabel: 'Ridicare',
  paymentLabel: 'Numerar',
  discount: 0,
  deliveryFee: 0,
  total: 100,
};

function adminEnv(db, email = 'manager@example.test', extra = {}) {
  return {
    DB: db,
    ENVIRONMENT: 'local',
    ADMIN_DEV_TOKEN: 'admin-test-token',
    ADMIN_DEV_EMAIL: email,
    ...extra,
  };
}

function adminContext(db, path, {
  method = 'GET', email = 'manager@example.test', origin = 'http://127.0.0.1:8788',
  body, idempotencyKey, env = {}, params = { id: 'order-1' },
} = {}) {
  const headers = new Headers({ authorization: 'Bearer admin-test-token' });
  if (method !== 'GET' && origin !== null) {
    headers.set('origin', origin);
    headers.set('sec-fetch-site', origin === 'http://127.0.0.1:8788' ? 'same-origin' : 'cross-site');
  }
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
  return {
    env: adminEnv(db, email, env),
    params,
    data: { requestId: 'req-admin-1' },
    request: new Request(`http://127.0.0.1:8788${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  };
}

test('Telegram success is persisted as immutable metadata without provider credentials or customer PII', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const token = 'telegram-super-secret-token';
  const result = await deliverTelegramNotification({
    db,
    env: {
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_CHAT_ID: 'secret-chat',
      TELEGRAM_FETCH: async () => Response.json({ ok: true }),
    },
    order: telegramOrder,
    requestKey: 'initial:order-1',
    requestId: 'req-success',
  });

  assert.equal(result.created, true);
  assert.equal(result.delivered, true);
  assert.equal(result.attempt.status, 'sent');
  const persisted = JSON.stringify({
    attempts: db.sqlite.prepare('SELECT * FROM notification_attempts').all(),
    statuses: db.sqlite.prepare('SELECT * FROM notification_attempt_statuses').all(),
  });
  for (const forbidden of [token, 'secret-chat', 'Ana Secret', '+37360000000', 'ana@example.test', 'Strada privata']) {
    assert.doesNotMatch(persisted, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.throws(
    () => db.sqlite.prepare("UPDATE notification_attempts SET request_id = 'changed'").run(),
    /immutable/i,
  );
  assert.throws(
    () => db.sqlite.prepare('DELETE FROM notification_attempt_statuses').run(),
    /immutable/i,
  );
});

test('a stale pending Telegram claim is closed and recovered exactly once', async (t) => {
  const db = setup();
  t.after(() => db.close());
  db.sqlite.prepare(`
    INSERT INTO notification_attempts (
      id, channel, event_type, entity_type, entity_id, order_id,
      request_key, request_id, created_at
    ) VALUES (
      'stuck-telegram-attempt', 'telegram', 'order_created', 'order',
      'order-1', 'order-1', 'order-created:order-1', 'req-before-crash',
      '2026-07-17T12:00:00.000Z'
    )
  `).run();
  db.sqlite.prepare(`
    INSERT INTO notification_attempt_statuses (
      id, attempt_id, phase, status, created_at
    ) VALUES (
      'stuck-telegram-accepted', 'stuck-telegram-attempt', 'accepted',
      'pending', '2026-07-17T12:00:00.000Z'
    )
  `).run();

  let deliveries = 0;
  const options = {
    db,
    env: {
      TELEGRAM_BOT_TOKEN: 'secret-token',
      TELEGRAM_CHAT_ID: 'secret-chat',
      TELEGRAM_FETCH: async () => {
        deliveries += 1;
        return Response.json({ ok: true });
      },
    },
    order: telegramOrder,
    eventType: 'order_created',
    requestKey: 'order-created:order-1',
    requestId: 'req-recovery',
    now: new Date('2026-07-17T12:10:00.000Z'),
    pendingLeaseMs: 60_000,
  };
  const [first, second] = await Promise.all([
    deliverTelegramNotification(options),
    deliverTelegramNotification(options),
  ]);

  assert.equal(deliveries, 1);
  assert.equal([first, second].filter((result) => result.created && result.delivered).length, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM notification_attempts').get().count, 2);
  const expired = db.sqlite.prepare(`
    SELECT status, failure_code FROM notification_attempt_statuses
    WHERE attempt_id = 'stuck-telegram-attempt' AND phase = 'outcome'
  `).get();
  assert.equal(expired.status, 'failed');
  assert.equal(expired.failure_code, 'NOTIFICATION_ATTEMPT_EXPIRED');
  assert.equal(db.sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM notification_attempt_statuses
    WHERE phase = 'outcome' AND status = 'sent'
  `).get().count, 1);
});

test('Telegram HTTP failure, timeout, and missing configuration have sanitized persisted outcomes', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const failureLogs = [];
  const originalConsoleError = console.error;
  let failed;
  console.error = (...parts) => failureLogs.push(parts.join(' '));
  try {
    failed = await deliverTelegramNotification({
      db,
      env: {
        TELEGRAM_BOT_TOKEN: 'secret-token', TELEGRAM_CHAT_ID: 'secret-chat',
        TELEGRAM_FETCH: async () => new Response('provider secret description', { status: 502 }),
      },
      order: telegramOrder,
      eventType: 'order_resend',
      requestKey: 'failure-request',
      requestId: 'req-http-failure',
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(failed.attempt.status, 'failed');
  assert.equal(failed.attempt.failureCode, 'TELEGRAM_HTTP_ERROR');
  assert.equal(failed.attempt.providerStatus, 502);
  assert.match(failureLogs.join('\n'), /"requestId":"req-http-failure"/);
  assert.doesNotMatch(failureLogs.join('\n'), /provider secret description|secret-token|secret-chat|ana@example/);

  const timedOut = await deliverTelegramNotification({
    db,
    env: {
      TELEGRAM_BOT_TOKEN: 'secret-token', TELEGRAM_CHAT_ID: 'secret-chat',
      TELEGRAM_FETCH: async () => new Promise(() => {}),
    },
    order: telegramOrder,
    eventType: 'order_resend',
    requestKey: 'timeout-request',
    requestId: 'req-timeout',
    timeoutMs: 5,
  });
  assert.equal(timedOut.attempt.failureCode, 'TELEGRAM_TIMEOUT');

  const missing = await deliverTelegramNotification({
    db,
    env: {},
    order: telegramOrder,
    eventType: 'order_resend',
    requestKey: 'missing-config-request',
    requestId: 'req-missing',
  });
  assert.equal(missing.attempt.failureCode, 'TELEGRAM_NOT_CONFIGURED');
  assert.doesNotMatch(
    JSON.stringify(db.sqlite.prepare('SELECT * FROM notification_attempt_statuses').all()),
    /provider secret description|secret-token|secret-chat/,
  );
});

test('admin Telegram resend is idempotent, audited, same-origin protected, and role protected', async (t) => {
  const db = setup();
  t.after(() => db.close());
  let deliveries = 0;
  const options = {
    method: 'POST',
    idempotencyKey: 'resend-request-0001',
    env: {
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: 'chat',
      TELEGRAM_FETCH: async () => { deliveries += 1; return Response.json({ ok: true }); },
    },
  };
  assert.equal(rateLimitRule(new Request(
    'https://nailmania.md/api/admin/orders/order-1/notifications/telegram',
    { method: 'POST' },
  )).scope, 'admin.telegram_resend');
  const [first, second] = await Promise.all([
    resendTelegram(adminContext(db, '/api/admin/orders/order-1/notifications/telegram', options)),
    resendTelegram(adminContext(db, '/api/admin/orders/order-1/notifications/telegram', options)),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  const createdResponse = first.status === 201 ? first : second;
  const createdPayload = await createdResponse.json();
  assert.equal(createdPayload.order.notifications.length, 1);
  assert.equal(createdPayload.order.notifications[0].status, 'sent');
  assert.equal(createdPayload.order.notifications[0].actor.id, 'manager-1');
  assert.equal(createdPayload.order.notifications[0].actor.name, 'manager user');
  assert.equal(deliveries, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM notification_attempts WHERE event_type = 'order_resend'").get().count, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE action = 'order.notification.telegram.resend'").get().count, 1);

  db.sqlite.prepare(`
    INSERT INTO notification_attempts (
      id, channel, event_type, entity_type, entity_id, order_id,
      request_key, created_at
    ) VALUES (
      'stale-admin-resend', 'telegram', 'order_resend', 'order',
      'order-1', 'order-1', 'stale-admin-key', '2020-01-01T00:00:00.000Z'
    )
  `).run();
  db.sqlite.prepare(`
    INSERT INTO notification_attempt_statuses (
      id, attempt_id, phase, status, created_at
    ) VALUES (
      'stale-admin-resend-accepted', 'stale-admin-resend', 'accepted',
      'pending', '2020-01-01T00:00:00.000Z'
    )
  `).run();
  const recovered = await resendTelegram(adminContext(
    db,
    '/api/admin/orders/order-1/notifications/telegram',
    { ...options, idempotencyKey: 'resend-request-0002' },
  ));
  assert.equal(recovered.status, 201);
  assert.equal(deliveries, 2);
  const staleOutcome = db.sqlite.prepare(`
    SELECT status, failure_code FROM notification_attempt_statuses
    WHERE attempt_id = 'stale-admin-resend' AND phase = 'outcome'
  `).get();
  assert.equal(staleOutcome.status, 'failed');
  assert.equal(staleOutcome.failure_code, 'NOTIFICATION_ATTEMPT_EXPIRED');

  const missingKey = await resendTelegram(adminContext(
    db, '/api/admin/orders/order-1/notifications/telegram', { ...options, idempotencyKey: undefined },
  ));
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const crossOrigin = await resendTelegram(adminContext(
    db,
    '/api/admin/orders/order-1/notifications/telegram',
    { ...options, idempotencyKey: 'resend-request-evil', origin: 'https://evil.test' },
  ));
  assert.equal(crossOrigin.status, 403);
  const customer = await resendTelegram(adminContext(
    db,
    '/api/admin/orders/order-1/notifications/telegram',
    { ...options, idempotencyKey: 'resend-request-customer', email: 'customer@example.test' },
  ));
  assert.equal(customer.status, 403);
});

test('password-reset email delivery and failure are persisted without raw email or reset token', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const delivered = [];
  const makeContext = (email, extraEnv = {}) => ({
    env: { DB: db, ENVIRONMENT: 'local', ...extraEnv },
    data: { requestId: email === 'customer@example.test' ? 'req-email-success' : 'req-email-missing' },
    request: new Request('http://shop.test/api/auth/forgot-password', {
      method: 'POST',
      headers: {
        origin: 'http://shop.test',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email, locale: 'ro' }),
    }),
  });

  const success = await forgotPassword(makeContext('customer@example.test', {
    CUSTOMER_EMAIL_SEND: async (message) => delivered.push(message),
  }));
  assert.equal(success.status, 202);
  assert.equal(delivered.length, 1);
  const rawToken = new URLSearchParams(new URL(delivered[0].resetUrl).hash.slice(1)).get('token');
  assert.ok(rawToken);
  assert.equal(db.sqlite.prepare(`
    SELECT outcome.status
    FROM notification_attempts a
    JOIN notification_attempt_statuses outcome ON outcome.attempt_id = a.id AND outcome.phase = 'outcome'
    WHERE a.event_type = 'password_reset'
  `).get().status, 'sent');
  const persisted = JSON.stringify(db.sqlite.prepare(`
    SELECT a.*, s.status, s.failure_code FROM notification_attempts a
    JOIN notification_attempt_statuses s ON s.attempt_id = a.id
  `).all());
  assert.doesNotMatch(persisted, /customer@example\.test/);
  assert.doesNotMatch(persisted, new RegExp(rawToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  db.sqlite.prepare(`
    INSERT INTO users (id, email, role, status) VALUES ('customer-2', 'second@example.test', 'customer', 'active')
  `).run();
  const emailFailureLogs = [];
  const originalConsoleError = console.error;
  let missingConfig;
  console.error = (...parts) => emailFailureLogs.push(parts.join(' '));
  try {
    missingConfig = await forgotPassword(makeContext('second@example.test'));
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(missingConfig.status, 202);
  assert.match(emailFailureLogs.join('\n'), /"requestId":"req-email-missing"/);
  assert.doesNotMatch(emailFailureLogs.join('\n'), /second@example\.test|password-reset:|reset-password/);
  const failedRow = db.sqlite.prepare(`
    SELECT outcome.status, outcome.failure_code, t.used_at
    FROM notification_attempts a
    JOIN notification_attempt_statuses outcome ON outcome.attempt_id = a.id AND outcome.phase = 'outcome'
    JOIN password_reset_tokens t ON t.id = a.entity_id
    WHERE a.entity_type = 'password_reset' AND a.entity_id <> (
      SELECT entity_id FROM notification_attempts WHERE event_type = 'password_reset' ORDER BY created_at LIMIT 1
    )
    ORDER BY a.created_at DESC LIMIT 1
  `).get();
  assert.deepEqual(
    { status: failedRow.status, code: failedRow.failure_code, invalidated: Boolean(failedRow.used_at) },
    { status: 'failed', code: 'EMAIL_SERVICE_UNAVAILABLE', invalidated: true },
  );
});

test('internal manager comment uses a separate optimistic revision and immutable audit entry', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const first = await updateInternalComment(adminContext(db, '/api/admin/orders/order-1/internal-comment', {
    method: 'PATCH',
    body: { comment: 'Verificat de manager', expectedRevision: null },
  }));
  assert.equal(first.status, 200);
  const firstPayload = await first.json();
  assert.match(firstPayload.order.internalCommentRevision, /^[0-9a-f-]{36}$/i);

  const stale = await updateInternalComment(adminContext(db, '/api/admin/orders/order-1/internal-comment', {
    method: 'PATCH',
    body: { comment: 'Suprascriere veche', expectedRevision: null },
  }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'ORDER_COMMENT_CONFLICT');
  assert.equal(db.sqlite.prepare("SELECT internal_comment FROM orders WHERE id = 'order-1'").get().internal_comment, 'Verificat de manager');
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE action = 'order.internal_comment.update'").get().count, 1);
  const audit = db.sqlite.prepare(`
    SELECT before_json, after_json FROM admin_audit_log
    WHERE action = 'order.internal_comment.update'
  `).get();
  assert.doesNotMatch(`${audit.before_json}\n${audit.after_json}`, /Verificat de manager|Suprascriere veche/);
  assert.deepEqual(JSON.parse(audit.before_json), { revision: null, present: false, length: 0 });
  assert.deepEqual(JSON.parse(audit.after_json), {
    revision: firstPayload.order.internalCommentRevision,
    present: true,
    length: 'Verificat de manager'.length,
  });
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM order_status_history').get().count, 0);

  const crossOrigin = await updateInternalComment(adminContext(db, '/api/admin/orders/order-1/internal-comment', {
    method: 'PATCH',
    origin: 'https://evil.test',
    body: { comment: 'evil', expectedRevision: firstPayload.order.internalCommentRevision },
  }));
  assert.equal(crossOrigin.status, 403);
});

test('admin readiness exposes only booleans, never configured secret values, and rejects managers', async (t) => {
  const db = setup();
  t.after(() => db.close());
  const secrets = {
    CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    CF_ACCESS_AUD: 'access-audience-secret',
    AUTH_FINGERPRINT_SALT: 'auth-fingerprint-super-secret',
    RATE_LIMIT_SECRET: 'rate-limit-super-secret',
    TURNSTILE_SECRET_KEY: 'turnstile-super-secret',
    TELEGRAM_BOT_TOKEN: 'telegram-super-secret',
    TELEGRAM_CHAT_ID: 'telegram-chat-secret',
    CUSTOMER_EMAIL_ENDPOINT: 'https://email.example.test/send',
    CUSTOMER_PASSWORD_RESET_URL: 'https://nailmania.md/reset-password',
    PRODUCT_IMAGES: {},
    R2_PUBLIC_BASE_URL: 'https://images.nailmania.md',
    PRODUCT_ANALYTICS: { writeDataPoint() {} },
    ANALYTICS_INDEX_SECRET: 'analytics-index-super-secret',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    ANALYTICS_READ_TOKEN: 'analytics-reader-super-secret',
    PRODUCT_ANALYTICS_DATASET: 'nailmania_product_events_production',
  };
  const response = await readiness(adminContext(db, '/api/admin/health/readiness', {
    email: 'admin@example.test',
    env: secrets,
  }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ready, true);
  assert.ok(Object.values(payload.checks).every((value) => typeof value === 'boolean' && value));
  assert.deepEqual({
    productAnalyticsBinding: payload.checks.productAnalyticsBinding,
    analyticsIndexSecret: payload.checks.analyticsIndexSecret,
    cloudflareAccountId: payload.checks.cloudflareAccountId,
    analyticsReadToken: payload.checks.analyticsReadToken,
    productAnalyticsDataset: payload.checks.productAnalyticsDataset,
  }, {
    productAnalyticsBinding: true,
    analyticsIndexSecret: true,
    cloudflareAccountId: true,
    analyticsReadToken: true,
    productAnalyticsDataset: true,
  });
  const serialized = JSON.stringify(payload);
  for (const value of Object.values(secrets).filter((item) => typeof item === 'string')) {
    assert.equal(serialized.includes(value), false);
  }

  const manager = await readiness(adminContext(db, '/api/admin/health/readiness', { env: secrets }));
  assert.equal(manager.status, 403);
  const notReady = await readiness(adminContext(db, '/api/admin/health/readiness', {
    email: 'admin@example.test',
    env: { ...secrets, TELEGRAM_BOT_TOKEN: '' },
  }));
  assert.equal(notReady.status, 503);
  const notReadyBody = await notReady.json();
  assert.equal(notReadyBody.checks.telegramBotToken, false);
  const analyticsNotReady = await readiness(adminContext(db, '/api/admin/health/readiness', {
    email: 'admin@example.test',
    env: { ...secrets, ANALYTICS_READ_TOKEN: '' },
  }));
  assert.equal(analyticsNotReady.status, 503);
  assert.equal((await analyticsNotReady.json()).checks.analyticsReadToken, false);
  const overprivilegedR2 = await readiness(adminContext(db, '/api/admin/health/readiness', {
    email: 'admin@example.test',
    env: { ...secrets, R2_ACCESS_KEY_ID: 'must-not-reach-pages-runtime' },
  }));
  assert.equal(overprivilegedR2.status, 503);
  const overprivilegedR2Body = await overprivilegedR2.json();
  assert.equal(overprivilegedR2Body.checks.r2ManagementCredentialsAbsent, false);
  assert.equal(JSON.stringify(overprivilegedR2Body).includes('must-not-reach-pages-runtime'), false);
  const rateLimitedR2 = await readiness(adminContext(db, '/api/admin/health/readiness', {
    email: 'admin@example.test',
    env: { ...secrets, R2_PUBLIC_BASE_URL: 'https://pub-example.r2.dev' },
  }));
  assert.equal(rateLimitedR2.status, 503);
  assert.equal((await rateLimitedR2.json()).checks.r2PublicBaseUrl, false);
});

test('scheduled auth cleanup can remove reset tokens but never notification audit history', async (t) => {
  const db = setup();
  t.after(() => db.close());
  db.sqlite.prepare(`
    INSERT INTO password_reset_tokens (
      id, user_id, token_hash, expires_at, used_at, created_at
    ) VALUES (
      'expired-reset', 'customer-1', 'expired-reset-hash',
      '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
    )
  `).run();
  db.sqlite.prepare(`
    INSERT INTO notification_attempts (
      id, channel, event_type, entity_type, entity_id, request_key, request_id, created_at
    ) VALUES (
      'email-attempt-old', 'email', 'password_reset', 'password_reset',
      'expired-reset', 'password-reset:expired-reset', 'req-cleanup', '2026-06-01T00:00:00.000Z'
    )
  `).run();
  db.sqlite.prepare(`
    INSERT INTO notification_attempt_statuses (
      id, attempt_id, phase, status, created_at
    ) VALUES (
      'email-attempt-old-pending', 'email-attempt-old', 'accepted', 'pending', '2026-06-01T00:00:00.000Z'
    )
  `).run();
  db.sqlite.prepare(`
    INSERT INTO notification_attempt_statuses (
      id, attempt_id, phase, status, created_at
    ) VALUES (
      'email-attempt-old-sent', 'email-attempt-old', 'outcome', 'sent', '2026-06-01T00:00:01.000Z'
    )
  `).run();

  await cleanupCustomerAuthRecords(db, { now: new Date('2026-07-17T12:00:00.000Z') });
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM password_reset_tokens WHERE id = 'expired-reset'").get().count, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM notification_attempts WHERE id = 'email-attempt-old'").get().count, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM notification_attempt_statuses WHERE attempt_id = 'email-attempt-old'").get().count, 2);
});
