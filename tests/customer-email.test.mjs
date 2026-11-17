import test from 'node:test';
import assert from 'node:assert/strict';
import {
  customerEmailDeliveryConfigured,
  sendOrderCustomerEmail,
  sendOrderConfirmationEmail,
  sendPasswordResetEmail,
} from '../functions/_lib/customer-email.js';

test('Resend password-reset adapter sends a localized, idempotent request', async () => {
  const requests = [];
  const apiToken = 're_test_secret_value';
  const env = {
    ENVIRONMENT: 'preview',
    CUSTOMER_EMAIL_ENDPOINT: 'https://api.resend.com/emails',
    CUSTOMER_EMAIL_FROM: 'Nail Mania <no-reply@mail.nailmania.md>',
    CUSTOMER_EMAIL_API_TOKEN: apiToken,
    CUSTOMER_EMAIL_FETCH: async (request) => {
      requests.push(request);
      return Response.json({ id: 'email-test-id' });
    },
  };

  assert.equal(customerEmailDeliveryConfigured(env), true);
  await sendPasswordResetEmail(env, {
    email: 'customer@example.test',
    locale: 'ru',
    resetUrl: 'https://nailmania.md/reset-password#token=a&step=1',
    expiresAt: '2026-08-01T12:00:00.000Z',
    idempotencyKey: 'password-reset-test-token',
  });

  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('authorization'), `Bearer ${apiToken}`);
  assert.equal(request.headers.get('user-agent'), 'nailmania-password-reset/1.0');
  assert.equal(request.headers.get('idempotency-key'), 'password-reset-test-token');
  const body = await request.json();
  assert.deepEqual(body.from, 'Nail Mania <no-reply@mail.nailmania.md>');
  assert.deepEqual(body.to, ['customer@example.test']);
  assert.equal(body.subject, 'Восстановление пароля Nail Mania');
  assert.match(body.text, /https:\/\/nailmania\.md\/reset-password#token=a&step=1/);
  assert.match(body.html, /token=a&amp;step=1/);
  assert.equal(JSON.stringify(body).includes(apiToken), false);
});

test('Resend readiness requires both API token and valid sender', () => {
  const base = {
    ENVIRONMENT: 'preview',
    CUSTOMER_EMAIL_ENDPOINT: 'https://api.resend.com/emails',
  };
  assert.equal(customerEmailDeliveryConfigured(base), false);
  assert.equal(customerEmailDeliveryConfigured({
    ...base,
    CUSTOMER_EMAIL_API_TOKEN: 're_test',
    CUSTOMER_EMAIL_FROM: 'invalid sender',
  }), false);
  assert.equal(customerEmailDeliveryConfigured({
    ...base,
    CUSTOMER_EMAIL_API_TOKEN: 're_test',
    CUSTOMER_EMAIL_FROM: 'Nail Mania <no-reply@mail.nailmania.md>',
  }), true);
  assert.equal(customerEmailDeliveryConfigured({
    ENVIRONMENT: 'preview',
    CUSTOMER_EMAIL_ENDPOINT: 'https://email.example.test/send',
  }), true);
});

test('Resend order confirmation includes the order lines, total, and idempotency key', async () => {
  const requests = [];
  const env = {
    ENVIRONMENT: 'production',
    CUSTOMER_EMAIL_ENDPOINT: 'https://api.resend.com/emails',
    CUSTOMER_EMAIL_FROM: 'Nail Mania <no-reply@mail.nailmania.md>',
    CUSTOMER_EMAIL_API_TOKEN: 're_order_test',
    CUSTOMER_EMAIL_FETCH: async (request) => {
      requests.push(request);
      return Response.json({ id: 'order-email-id' });
    },
  };
  await sendOrderConfirmationEmail(env, {
    email: 'buyer@example.test',
    locale: 'ru',
    idempotencyKey: 'order-confirmation-order-1',
    order: {
      id: 'order-1',
      no: 'NM-TEST-1',
      items: [{ name: 'Gel polish <Red>', quantity: 2, lineTotal: 180 }],
      discount: 20,
      deliveryFee: 70,
      total: 230,
      deliveryLabel: 'Курьер',
      paymentLabel: 'Наличными',
    },
  });

  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.headers.get('idempotency-key'), 'order-confirmation-order-1');
  assert.equal(request.headers.get('user-agent'), 'nailmania-order-confirmation/1.0');
  const body = await request.json();
  assert.deepEqual(body.to, ['buyer@example.test']);
  assert.equal(body.subject, 'Заказ NM-TEST-1 принят');
  assert.match(body.text, /Gel polish <Red> x 2 - 180 lei/);
  assert.match(body.text, /Итого: 230 lei/);
  assert.match(body.html, /Gel polish &lt;Red&gt;/);
  assert.doesNotMatch(body.html, /Gel polish <Red>/);
});

test('order lifecycle emails use branded localized templates without internal data', async () => {
  const requests = [];
  const env = {
    ENVIRONMENT: 'production',
    SITE_URL: 'https://nailmania.md',
    CUSTOMER_EMAIL_ENDPOINT: 'https://api.resend.com/emails',
    CUSTOMER_EMAIL_FROM: 'Nail Mania <no-reply@mail.nailmania.md>',
    CUSTOMER_EMAIL_REPLY_TO: 'support@nailmania.md',
    CUSTOMER_EMAIL_API_TOKEN: 're_order_events',
    CUSTOMER_EMAIL_FETCH: async (request) => {
      requests.push(request);
      return Response.json({ id: `email-${requests.length}` });
    },
  };
  const order = {
    id: 'order-account-1',
    no: 'NM-EVENT-1',
    userId: 'customer-1',
    customer: { name: 'Ana <Test>', city: 'Chișinău', address: 'Strada 1' },
    items: [{ name: 'Gel <Rose>', quantity: 1, lineTotal: 100 }],
    discount: 10,
    deliveryFee: 0,
    total: 90,
    deliveryLabel: 'Curier',
    paymentLabel: 'Numerar',
    internalComment: 'NEVER INCLUDE MANAGER SECRET',
    return: {
      id: 'return-1',
      refundAmount: 45,
      reason: 'NEVER INCLUDE RETURN REASON',
      items: [{ name: 'Gel <Rose>', quantity: 1, lineTotal: 45 }],
    },
  };

  for (const eventType of ['order_confirmed', 'order_cancelled', 'order_returned']) {
    await sendOrderCustomerEmail(env, {
      email: 'buyer@example.test', locale: 'ro', order, eventType,
      idempotencyKey: `event/${eventType}`,
    });
  }

  assert.equal(requests.length, 3);
  const bodies = await Promise.all(requests.map((request) => request.clone().json()));
  assert.match(bodies[0].subject, /confirmată/);
  assert.match(bodies[1].subject, /anulată/);
  assert.match(bodies[2].subject, /Returul/);
  assert.match(bodies[0].html, /images\/logo-high\.png/);
  assert.match(bodies[0].html, /Ana &lt;Test&gt;/);
  assert.match(bodies[0].html, /account\/orders\/order-account-1/);
  assert.match(bodies[2].text, /Suma returului: 45 lei/);
  assert.doesNotMatch(JSON.stringify(bodies), /NEVER INCLUDE/);
  assert.equal(bodies[0].reply_to, 'support@nailmania.md');
  assert.equal(requests[0].headers.get('user-agent'), 'nailmania-order-notification/1.0');
  assert.equal(requests[2].headers.get('idempotency-key'), 'event/order_returned');
});
