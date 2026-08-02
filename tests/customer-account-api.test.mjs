import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newSessionRecord } from '../functions/_lib/customer-auth.js';
import { onRequestPost as register } from '../functions/api/auth/register.js';
import { onRequestPost as login } from '../functions/api/auth/login.js';
import { onRequestPost as logout } from '../functions/api/auth/logout.js';
import { onRequestGet as sessionStatus } from '../functions/api/auth/session.js';
import { onRequestPost as forgotPassword } from '../functions/api/auth/forgot-password.js';
import { onRequestPost as resetPassword } from '../functions/api/auth/reset-password.js';
import {
  onRequestGet as listAddresses,
  onRequestPost as createAddress,
} from '../functions/api/me/addresses/index.js';
import {
  onRequestDelete as deleteAddress,
  onRequestPatch as patchAddress,
} from '../functions/api/me/addresses/[id].js';
import { onRequestGet as listOrders } from '../functions/api/me/orders/index.js';
import { onRequestGet as getOrder } from '../functions/api/me/orders/[id].js';
import { onRequestGet as getProfile, onRequestPatch as patchProfile } from '../functions/api/me/index.js';
import { onRequestPost as createOrder } from '../functions/api/orders.js';
import { SqliteD1 } from './helpers/sqlite-d1.mjs';
import { withOrderContract } from './helpers/order-fixture.mjs';

const schema = [1, 2, 3, 4, 5, 6]
  .map((number) => readFileSync(new URL(`../migrations/${String(number).padStart(4, '0')}_${[
    'initial',
    'order_transitions',
    'admin_products',
    'admin_categories',
    'customer_accounts',
    'returns_and_admin_journals',
  ][number - 1]}.sql`, import.meta.url), 'utf8'))
  .concat(readFileSync(new URL('../migrations/0007_catalog_cache.sql', import.meta.url), 'utf8'))
  .concat(readFileSync(new URL('../migrations/0009_promotions.sql', import.meta.url), 'utf8'))
  .concat(readFileSync(new URL('../migrations/0010_statistics_and_analytics.sql', import.meta.url), 'utf8'))
  .concat(readFileSync(new URL('../migrations/0011_notifications_and_order_operations.sql', import.meta.url), 'utf8'))
  .concat(readFileSync(new URL('../migrations/0012_order_idempotency.sql', import.meta.url), 'utf8'))
  .concat(readFileSync(new URL('../migrations/0013_order_commercial_snapshot_guard.sql', import.meta.url), 'utf8'))
  .concat(readFileSync(new URL('../migrations/0014_catalog_discounts_and_promo_brands.sql', import.meta.url), 'utf8'))
  .join('\n');

const baseUrl = 'http://shop.test';
const cookieValue = (response) => String(response.headers.get('set-cookie') || '').split(';')[0];
const responseJson = async (response) => ({ response, body: await response.json() });

function request(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const finalHeaders = new Headers(headers);
  if (method !== 'GET') {
    finalHeaders.set('origin', baseUrl);
    finalHeaders.set('sec-fetch-site', 'same-origin');
    finalHeaders.set('content-type', 'application/json');
  }
  if (cookie) finalHeaders.set('cookie', cookie);
  return new Request(`${baseUrl}${path}`, {
    method,
    headers: finalHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const context = (db, requestValue, extra = {}) => ({
  request: requestValue,
  env: { DB: db, ENVIRONMENT: 'local', ...extra.env },
  params: extra.params || {},
});

async function seedCustomer(db, id, email) {
  db.sqlite.prepare(`
    INSERT INTO users (id, email, name, role, status, password_hash)
    VALUES (?, ?, ?, 'customer', 'active', 'not-used-by-this-test')
  `).run(id, email, id);
  const loginRequest = request('/api/auth/login', { method: 'POST', body: {} });
  const session = await newSessionRecord(db, id, loginRequest, { ENVIRONMENT: 'local' });
  await session.statement.run();
  return `nm_session=${session.token}`;
}

test('auth endpoints keep credentials and one-time reset tokens out of API and database plaintext', async (t) => {
  const db = new SqliteD1(schema);
  t.after(() => db.close());
  const delivered = [];
  const emailEnv = { CUSTOMER_EMAIL_SEND: async (message) => delivered.push(message) };

  const registered = await responseJson(await register(context(db, request('/api/auth/register', {
    method: 'POST',
    body: { email: 'ana@example.com', password: 'initial password', name: 'Ana', phone: '+373 60000001' },
  }))));
  assert.equal(registered.response.status, 201);
  assert.equal(registered.body.user.email, 'ana@example.com');
  assert.equal('password' in registered.body.user, false);
  const registrationCookie = cookieValue(registered.response);
  assert.match(registrationCookie, /^nm_session=/);

  const current = await responseJson(await sessionStatus(context(db, request('/api/auth/session', {
    cookie: registrationCookie,
  }))));
  assert.equal(current.body.authenticated, true);

  const loggedOut = await logout(context(db, request('/api/auth/logout', {
    method: 'POST', body: {}, cookie: registrationCookie,
  })));
  assert.equal(loggedOut.status, 200);
  const afterLogout = await responseJson(await sessionStatus(context(db, request('/api/auth/session', {
    cookie: registrationCookie,
  }))));
  assert.equal(afterLogout.body.authenticated, false);

  const loggedIn = await responseJson(await login(context(db, request('/api/auth/login', {
    method: 'POST', body: { email: 'ana@example.com', password: 'initial password' },
  }))));
  assert.equal(loggedIn.response.status, 200);
  const oldSessionCookie = cookieValue(loggedIn.response);
  const [wrongExisting, missingAccount] = await Promise.all([
    login(context(db, request('/api/auth/login', {
      method: 'POST', body: { email: 'ana@example.com', password: 'wrong password' },
    }))),
    login(context(db, request('/api/auth/login', {
      method: 'POST', body: { email: 'missing@example.com', password: 'wrong password' },
    }))),
  ]);
  assert.equal(wrongExisting.status, 401);
  assert.equal(missingAccount.status, 401);
  assert.deepEqual((await wrongExisting.json()).error, (await missingAccount.json()).error);

  const forgotten = await responseJson(await forgotPassword(context(db, request('/api/auth/forgot-password', {
    method: 'POST', body: { email: 'ana@example.com', locale: 'ro' },
  }), { env: emailEnv })));
  assert.equal(forgotten.response.status, 202);
  assert.equal(delivered.length, 1);
  const deliveredUrl = new URL(delivered[0].resetUrl);
  const rawToken = new URLSearchParams(deliveredUrl.hash.slice(1)).get('token');
  assert.match(rawToken, /^[A-Za-z0-9_-]{32,128}$/);
  assert.equal(deliveredUrl.searchParams.has('token'), false);
  assert.doesNotMatch(JSON.stringify(forgotten.body), new RegExp(rawToken));
  const stored = db.sqlite.prepare('SELECT token_hash FROM password_reset_tokens').get();
  assert.notEqual(stored.token_hash, rawToken);
  assert.equal(stored.token_hash.length, 64);
  const unknownForgotten = await responseJson(await forgotPassword(context(db, request('/api/auth/forgot-password', {
    method: 'POST', body: { email: 'missing@example.com' },
  }), { env: emailEnv })));
  assert.equal(unknownForgotten.response.status, 202);
  assert.deepEqual(unknownForgotten.body, forgotten.body);
  assert.equal(delivered.length, 1);

  const reset = await responseJson(await resetPassword(context(db, request('/api/auth/reset-password', {
    method: 'POST', body: { token: rawToken, password: 'replacement password' },
  }))));
  assert.equal(reset.response.status, 200);
  assert.deepEqual(reset.body, { ok: true });

  const reused = await responseJson(await resetPassword(context(db, request('/api/auth/reset-password', {
    method: 'POST', body: { token: rawToken, password: 'another replacement' },
  }))));
  assert.equal(reused.response.status, 400);
  assert.equal(reused.body.error.code, 'INVALID_RESET_TOKEN');
  const revokedStatus = await responseJson(await sessionStatus(context(db, request('/api/auth/session', {
    cookie: oldSessionCookie,
  }))));
  assert.equal(revokedStatus.body.authenticated, false);

  const oldPassword = await responseJson(await login(context(db, request('/api/auth/login', {
    method: 'POST', body: { email: 'ana@example.com', password: 'initial password' },
  }))));
  assert.equal(oldPassword.response.status, 401);
  assert.equal(oldPassword.body.error.code, 'INVALID_CREDENTIALS');
  const newPassword = await login(context(db, request('/api/auth/login', {
    method: 'POST', body: { email: 'ana@example.com', password: 'replacement password' },
  })));
  assert.equal(newPassword.status, 200);
});

test('address and order handlers cannot read, change, or delete another customer data', async (t) => {
  const db = new SqliteD1(schema);
  t.after(() => db.close());
  const anaCookie = await seedCustomer(db, 'customer-ana', 'ana@example.com');
  const ionCookie = await seedCustomer(db, 'customer-ion', 'ion@example.com');

  const patchedProfile = await responseJson(await patchProfile(context(db, request('/api/me', {
    method: 'PATCH',
    cookie: anaCookie,
    body: { name: 'Ana Actualizata', phone: '+373 61111111', email: 'stolen@example.com', role: 'admin' },
  }))));
  assert.equal(patchedProfile.response.status, 200);
  assert.equal(patchedProfile.body.user.name, 'Ana Actualizata');
  assert.equal(patchedProfile.body.user.email, 'ana@example.com');
  assert.equal(patchedProfile.body.user.role, 'customer');
  const profile = await responseJson(await getProfile(context(db, request('/api/me', { cookie: anaCookie }))));
  assert.equal(profile.body.user.phone, '+373 61111111');

  const created = await responseJson(await createAddress(context(db, request('/api/me/addresses', {
    method: 'POST',
    cookie: anaCookie,
    body: {
      recipientName: 'Ana Test', phone: '+373 60000001', city: 'Chisinau',
      address: 'Strada Test 1', comment: 'Sunati', isDefault: true,
    },
  }))));
  assert.equal(created.response.status, 201);
  const anaAddressId = created.body.address.id;

  const ionList = await responseJson(await listAddresses(context(db, request('/api/me/addresses', {
    cookie: ionCookie,
  }))));
  assert.deepEqual(ionList.body.items, []);
  const foreignPatch = await responseJson(await patchAddress(context(db, request(`/api/me/addresses/${anaAddressId}`, {
    method: 'PATCH', cookie: ionCookie, body: { city: 'Balti' },
  }), { params: { id: anaAddressId } })));
  assert.equal(foreignPatch.response.status, 404);
  const foreignDelete = await deleteAddress(context(db, request(`/api/me/addresses/${anaAddressId}`, {
    method: 'DELETE', cookie: ionCookie, body: {},
  }), { params: { id: anaAddressId } }));
  assert.equal(foreignDelete.status, 404);
  assert.equal(db.sqlite.prepare('SELECT city FROM user_addresses WHERE id = ?').get(anaAddressId).city, 'Chisinau');

  const keptDefault = await responseJson(await patchAddress(context(db, request(`/api/me/addresses/${anaAddressId}`, {
    method: 'PATCH', cookie: anaCookie, body: { isDefault: false },
  }), { params: { id: anaAddressId } })));
  assert.equal(keptDefault.body.address.isDefault, true);

  const secondAddress = await responseJson(await createAddress(context(db, request('/api/me/addresses', {
    method: 'POST',
    cookie: anaCookie,
    body: {
      recipientName: 'Ana Test', phone: '+373 60000001', city: 'Balti',
      address: 'Strada Test 2', isDefault: false,
    },
  }))));
  const secondId = secondAddress.body.address.id;
  const madeDefault = await responseJson(await patchAddress(context(db, request(`/api/me/addresses/${secondId}`, {
    method: 'PATCH', cookie: anaCookie, body: { isDefault: true },
  }), { params: { id: secondId } })));
  assert.equal(madeDefault.body.address.isDefault, true);
  assert.equal(db.sqlite.prepare(`
    SELECT COUNT(*) AS count FROM user_addresses WHERE user_id = 'customer-ana' AND is_default = 1
  `).get().count, 1);
  const deletedOwn = await deleteAddress(context(db, request(`/api/me/addresses/${secondId}`, {
    method: 'DELETE', cookie: anaCookie, body: {},
  }), { params: { id: secondId } }));
  assert.equal(deletedOwn.status, 200);
  assert.equal(db.sqlite.prepare('SELECT is_default FROM user_addresses WHERE id = ?').get(anaAddressId).is_default, 1);

  db.sqlite.prepare(`
    INSERT INTO orders (
      id, order_no, user_id, status, language, customer_name, customer_phone,
      customer_email, city, address, internal_comment, delivery_method, delivery_label,
      payment_method, payment_label, items_subtotal, total_amount
    ) VALUES (?, ?, ?, 'pending', 'ro', ?, ?, ?, ?, ?, ?, 'pickup', 'Ridicare', 'cash', 'Numerar', 100, 100)
  `).run('order-ana', 'NM-ANA', 'customer-ana', 'Ana', '060000001', 'ana@example.com', 'Chisinau', 'Secret address', 'INTERNAL SECRET');
  db.sqlite.prepare(`
    INSERT INTO orders (
      id, order_no, user_id, status, language, customer_name, customer_phone,
      delivery_method, delivery_label, payment_method, payment_label, items_subtotal, total_amount
    ) VALUES (?, ?, ?, 'confirmed', 'ro', ?, ?, 'pickup', 'Ridicare', 'cash', 'Numerar', 200, 200)
  `).run('order-ion', 'NM-ION', 'customer-ion', 'Ion', '060000002');
  db.sqlite.prepare(`
    INSERT INTO order_status_history (order_id, from_status, to_status, comment)
    VALUES ('order-ana', NULL, 'pending', 'PRIVATE MANAGER COMMENT')
  `).run();

  const ionOrders = await responseJson(await listOrders(context(db, request('/api/me/orders', {
    cookie: ionCookie,
  }))));
  assert.deepEqual(ionOrders.body.items.map((order) => order.id), ['order-ion']);
  const foreignOrder = await responseJson(await getOrder(context(db, request('/api/me/orders/order-ana', {
    cookie: ionCookie,
  }), { params: { id: 'order-ana' } })));
  assert.equal(foreignOrder.response.status, 404);
  assert.equal(foreignOrder.body.error.code, 'ORDER_NOT_FOUND');

  const ownOrder = await responseJson(await getOrder(context(db, request('/api/me/orders/NM-ANA', {
    cookie: anaCookie,
  }), { params: { id: 'NM-ANA' } })));
  assert.equal(ownOrder.response.status, 200);
  assert.equal(ownOrder.body.order.id, 'order-ana');
  assert.doesNotMatch(JSON.stringify(ownOrder.body), /INTERNAL SECRET|PRIVATE MANAGER COMMENT/);
});

test('POST /api/orders links a valid session but preserves guest checkout', async (t) => {
  const db = new SqliteD1(schema);
  t.after(() => db.close());
  const customerCookie = await seedCustomer(db, 'customer-1', 'customer@example.com');
  db.sqlite.prepare(`
    INSERT INTO categories (id, slug, name_ro) VALUES ('gel', 'gel', 'Gel')
  `).run();
  db.sqlite.prepare(`
    INSERT INTO products (
      id, catalog_key, sku, slug, category_id, brand, name_ro, price, old_price
    ) VALUES (1, 'product-1', 'SKU-1', 'product-1', 'gel', 'Brand', 'Produs', 100, 120)
  `).run();
  db.sqlite.prepare(`
    INSERT INTO inventory (product_id, warehouse_id, on_hand, reserved)
    VALUES (1, 1, 5, 0)
  `).run();
  const orderBody = {
    lang: 'ro',
    delivery: 'pickup',
    payment: 'cash',
    customer: { name: 'Ana', phone: '060000001', email: 'customer@example.com' },
    items: [{ productKey: 'product-1', quantity: 1 }],
  };
  const authenticated = await createOrder(context(db, request('/api/orders', {
    method: 'POST', cookie: customerCookie, body: withOrderContract(db, orderBody),
  })));
  assert.equal(authenticated.status, 201);
  const first = db.sqlite.prepare('SELECT user_id FROM orders ORDER BY created_at, id LIMIT 1').get();
  assert.equal(first.user_id, 'customer-1');

  const guest = await createOrder(context(db, request('/api/orders', {
    method: 'POST', body: withOrderContract(db, orderBody),
  })));
  assert.equal(guest.status, 201);
  const rows = db.sqlite.prepare('SELECT user_id FROM orders ORDER BY created_at, id').all();
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.user_id === null).length, 1);
});
