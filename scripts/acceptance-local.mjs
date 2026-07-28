import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrderQuote } from '../shared/order-quote.js';
import { resolveReportFile, serializeJsonReport, writeJsonReportFile } from './report-file.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8788';
const DEFAULT_ADMIN_TOKEN = 'nailmania-local-admin-only';
const FREE_DELIVERY_THRESHOLD = 2200;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const ACCEPTANCE_USAGE = `Usage:
  node scripts/acceptance-local.mjs \\
    --base-url http://127.0.0.1:8788 \\
    --admin-token nailmania-local-admin-only \\
    --confirm-local-mutations \\
    [--report-file tmp/reports/local-acceptance.json]

Prerequisites and assumptions:
  1. Apply every local D1 migration, import the validated catalog, and run
     npm.cmd run db:seed-admin:local before starting the Pages server.
  2. Start the server with npm.cmd run dev:cloudflare. That command sets
     ENVIRONMENT=local, enables the server-side Turnstile bypass, and does not
     bind production Telegram or email credentials.
  3. The catalog must contain enough currently available stock to build a cart
     worth at least 2200 lei. The harness uses only server prices and verifies
     every selected SKU through its availability endpoint.
  4. The harness writes fake local data, cancels the created order (releasing
     stock and promo redemption), and deactivates its temporary promo. The
     cancelled order and audit journal intentionally remain as acceptance proof.

Safety:
  Mutations are refused unless the base URL is exactly localhost, 127.0.0.1,
  or ::1 and --confirm-local-mutations is present. Redirects are refused so an
  admin token or fake order payload cannot be forwarded to another host.
  Optional JSON reports are written atomically only after success and only below
  tmp/reports; they contain technical IDs and boolean readiness checks, never the
  admin token or fake customer contact fields.`;

export class LocalAcceptanceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LocalAcceptanceError';
    this.details = details;
  }
}

export function parseArguments(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!String(key).startsWith('--')) throw new LocalAcceptanceError(`Unknown positional argument: ${key}`);
    const next = argv[index + 1];
    if (!next || String(next).startsWith('--')) result.set(key, true);
    else {
      result.set(key, next);
      index += 1;
    }
  }
  return result;
}

export function isLoopbackBaseUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { return false; }
  return ['http:', 'https:'].includes(url.protocol)
    && LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    && !url.username
    && !url.password
    && !url.search
    && !url.hash
    && (url.pathname === '/' || url.pathname === '');
}

export function assertLocalMutationSafety(baseUrl, confirmed) {
  if (!isLoopbackBaseUrl(baseUrl)) {
    throw new LocalAcceptanceError(
      'Mutating acceptance is restricted to an exact localhost/127.0.0.1/::1 base URL',
    );
  }
  if (confirmed !== true) {
    throw new LocalAcceptanceError('Mutating acceptance requires --confirm-local-mutations');
  }
  return new URL(baseUrl);
}

const finiteMoney = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const integerStock = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 99) : 0;
};

function normalizeCartProducts(products) {
  const unique = new Map();
  for (const product of products || []) {
    const productKey = String(product?.key ?? product?.productKey ?? '').trim();
    const unitPrice = finiteMoney(product?.price ?? product?.unitPrice);
    const stock = integerStock(product?.stock ?? product?.available);
    if (!productKey || !unitPrice || !stock || unique.has(productKey)) continue;
    unique.set(productKey, {
      productId: product?.id ?? product?.productId ?? null,
      productKey,
      unitPrice,
      listPrice: Number(product?.old ?? product?.listPrice) > unitPrice
        ? Number(product.old ?? product.listPrice)
        : unitPrice,
      stock,
    });
  }
  return [...unique.values()];
}

function greedyCart(products, threshold, direction, maxLines, maxTotalQuantity) {
  const sorted = [...products].sort((left, right) => direction * (left.unitPrice - right.unitPrice)
    || left.productKey.localeCompare(right.productKey));
  const items = [];
  let subtotal = 0;
  let totalQuantity = 0;
  for (const product of sorted) {
    if (subtotal >= threshold || items.length >= maxLines || totalQuantity >= maxTotalQuantity) break;
    const remainingQuantity = maxTotalQuantity - totalQuantity;
    const usefulQuantity = Math.max(1, Math.ceil((threshold - subtotal) / product.unitPrice));
    const quantity = Math.min(product.stock, usefulQuantity, remainingQuantity);
    if (quantity < 1) continue;
    items.push({
      productId: product.productId,
      productKey: product.productKey,
      unitPrice: product.unitPrice,
      listPrice: product.listPrice,
      quantity,
    });
    subtotal += product.unitPrice * quantity;
    totalQuantity += quantity;
  }
  return { items, subtotal, totalQuantity };
}

function singleProductCarts(products, threshold, maxTotalQuantity) {
  return products.flatMap((product) => {
    const quantity = Math.ceil(threshold / product.unitPrice);
    if (quantity > product.stock || quantity > maxTotalQuantity) return [];
    return [{
      items: [{
        productId: product.productId,
        productKey: product.productKey,
        unitPrice: product.unitPrice,
        listPrice: product.listPrice,
        quantity,
      }],
      subtotal: product.unitPrice * quantity,
      totalQuantity: quantity,
    }];
  });
}

export function buildThresholdCart(products, {
  threshold = FREE_DELIVERY_THRESHOLD,
  maxLines = 50,
  maxTotalQuantity = 200,
} = {}) {
  const target = Number(threshold);
  if (!Number.isFinite(target) || target <= 0) throw new LocalAcceptanceError('Cart threshold must be positive');
  const normalized = normalizeCartProducts(products);
  const candidates = [
    ...singleProductCarts(normalized, target, maxTotalQuantity),
    greedyCart(normalized, target, -1, maxLines, maxTotalQuantity),
    greedyCart(normalized, target, 1, maxLines, maxTotalQuantity),
  ].filter((candidate) => candidate.subtotal >= target
    && candidate.items.length > 0
    && candidate.items.length <= maxLines
    && candidate.totalQuantity <= maxTotalQuantity);
  candidates.sort((left, right) => left.subtotal - right.subtotal
    || left.totalQuantity - right.totalQuantity
    || left.items.length - right.items.length);
  if (!candidates.length) {
    const availableValue = normalized.reduce((sum, product) => sum + product.unitPrice * product.stock, 0);
    throw new LocalAcceptanceError(
      `Available catalog stock cannot build a ${target} lei cart within order limits`,
      { target, availableValue },
    );
  }
  return candidates[0];
}

function assert(condition, message, details = {}) {
  if (!condition) throw new LocalAcceptanceError(message, details);
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const almostEqual = (left, right) => Math.abs(Number(left) - Number(right)) < 0.000001;

async function fetchResponse(base, pathname, options = {}) {
  const url = new URL(pathname, base);
  const response = await fetch(url, {
    redirect: 'error',
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  return { response, url };
}

async function jsonRequest(base, pathname, {
  method = 'GET', body, headers = {}, expected = [200], label = pathname,
} = {}) {
  const { response, url } = await fetchResponse(base, pathname, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let payload;
  try { payload = await response.json(); }
  catch {
    throw new LocalAcceptanceError(`${label} did not return JSON`, {
      status: response.status,
      requestId: response.headers.get('x-request-id') || '',
      url: url.href,
    });
  }
  if (!expected.includes(response.status)) {
    throw new LocalAcceptanceError(`${label} returned HTTP ${response.status}`, {
      status: response.status,
      requestId: response.headers.get('x-request-id') || '',
      error: payload?.error || null,
      url: url.href,
    });
  }
  return { payload, response };
}

async function poll(operation, predicate, { attempts = 20, delayMs = 100 } = {}) {
  let value;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    value = await operation();
    if (predicate(value)) return value;
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return value;
}

const adminHeaders = (base, adminToken, mutation = false) => ({
  authorization: `Bearer ${adminToken}`,
  ...(mutation ? { origin: base.origin, 'sec-fetch-site': 'same-origin' } : {}),
});

async function availability(base, productKey) {
  const result = await jsonRequest(
    base,
    `/api/products/${encodeURIComponent(productKey)}/availability`,
    { label: `availability for ${productKey}` },
  );
  const record = result.payload?.availability;
  assert(result.payload?.ok === true && isObject(record), 'Availability response contract is invalid', { productKey });
  assert(record.productKey === productKey, 'Availability response identifies a different product', {
    expected: productKey,
    actual: record.productKey,
  });
  assert(Number.isInteger(Number(record.available)) && Number(record.available) >= 0, 'Availability is invalid', {
    productKey,
    available: record.available,
  });
  return Number(record.available);
}

async function deactivatePromo(base, adminToken, promo) {
  if (!promo?.id || !promo?.revision || promo.isActive === false) return null;
  return jsonRequest(base, `/api/admin/promos/${encodeURIComponent(promo.id)}`, {
    method: 'DELETE',
    body: { revision: promo.revision },
    headers: adminHeaders(base, adminToken, true),
    expected: [200],
    label: 'temporary promo cleanup',
  });
}

async function cancelOrder(base, adminToken, orderId, comment) {
  return jsonRequest(base, `/api/admin/orders/${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    body: { status: 'cancelled', comment },
    headers: adminHeaders(base, adminToken, true),
    expected: [200],
    label: 'order cancellation',
  });
}

export async function runLocalAcceptance({
  baseUrl = DEFAULT_BASE_URL,
  adminToken = DEFAULT_ADMIN_TOKEN,
  confirmLocalMutations = false,
} = {}) {
  const base = assertLocalMutationSafety(baseUrl, confirmLocalMutations);
  const token = String(adminToken || '').trim();
  assert(token.length > 0, 'Local admin token is required');

  let temporaryPromo = null;
  let order = null;
  let orderCancelled = false;
  const cleanupErrors = [];

  try {
    const catalogResult = await jsonRequest(base, '/api/products?limit=5000&stock=in&sort=price_asc', {
      label: 'public catalog',
    });
    const products = catalogResult.payload?.items;
    assert(catalogResult.payload?.ok === true && Array.isArray(products) && products.length > 0,
      'Public catalog is empty or has an invalid response contract');

    const candidateCart = buildThresholdCart(products);
    const verified = [];
    const availabilityBefore = new Map();
    for (const item of candidateCart.items) {
      const available = await availability(base, item.productKey);
      availabilityBefore.set(item.productKey, available);
      verified.push({ ...item, stock: available, price: item.unitPrice, key: item.productKey });
    }
    let cart;
    try { cart = buildThresholdCart(verified); }
    catch {
      // The catalog cache and the point availability endpoint can legitimately
      // differ during an admin edit. Verify additional server catalog rows and
      // rebuild rather than placing an order from stale quantities.
      const selected = new Set(verified.map((item) => item.productKey));
      for (const product of products) {
        if (selected.has(product.key)) continue;
        const available = await availability(base, product.key);
        availabilityBefore.set(product.key, available);
        verified.push({ ...product, stock: available });
        try { cart = buildThresholdCart(verified); break; }
        catch { /* keep gathering authoritative availability */ }
      }
      if (!cart) cart = buildThresholdCart(verified);
    }
    assert(cart.subtotal >= FREE_DELIVERY_THRESHOLD, 'Verified cart is below the free-delivery threshold', {
      subtotal: cart.subtotal,
    });
    // Retain only baselines used by the final rebuilt cart.
    for (const item of cart.items) {
      if (!availabilityBefore.has(item.productKey)) {
        availabilityBefore.set(item.productKey, await availability(base, item.productKey));
      }
      assert(availabilityBefore.get(item.productKey) >= item.quantity, 'Verified stock is insufficient', {
        productKey: item.productKey,
        available: availabilityBefore.get(item.productKey),
        requested: item.quantity,
      });
    }

    const representative = cart.items[0];
    const productResult = await jsonRequest(base, `/api/products/${encodeURIComponent(representative.productKey)}`, {
      label: 'public product detail',
    });
    assert(productResult.payload?.ok === true
      && productResult.payload?.item?.key === representative.productKey,
    'Public product detail contract is invalid');

    const sitemapResult = await fetchResponse(base, '/sitemap.xml', { headers: { accept: 'application/xml' } });
    const sitemap = await sitemapResult.response.text();
    assert(sitemapResult.response.status === 200
      && /application\/xml/i.test(sitemapResult.response.headers.get('content-type') || '')
      && sitemap.includes('<urlset'), 'Sitemap contract is invalid', { status: sitemapResult.response.status });

    const sessionResult = await jsonRequest(base, '/api/admin/session', {
      headers: adminHeaders(base, token),
      label: 'admin session',
    });
    assert(sessionResult.payload?.ok === true
      && sessionResult.payload?.authSource === 'local'
      && sessionResult.payload?.user?.role === 'admin', 'Local admin session contract is invalid');

    const now = new Date();
    const code = `ACC_${now.getTime().toString(36)}_${crypto.randomUUID().slice(0, 6)}`.toUpperCase();
    const promoCreate = await jsonRequest(base, '/api/admin/promos', {
      method: 'POST',
      headers: adminHeaders(base, token, true),
      expected: [201],
      label: 'temporary promo creation',
      body: {
        code,
        discountType: 'percent',
        discountValue: 50,
        maxDiscount: null,
        minOrderAmount: FREE_DELIVERY_THRESHOLD,
        startsAt: new Date(now.getTime() - 60_000).toISOString(),
        endsAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
        totalUseLimit: 1,
        perUserLimit: null,
        isActive: true,
        categoryIds: [],
        productIds: [],
      },
    });
    temporaryPromo = promoCreate.payload?.promo;
    assert(temporaryPromo?.id && temporaryPromo?.code === code && temporaryPromo?.revision,
      'Temporary promo response contract is invalid');

    const cartIdentity = cart.items.map((item) => ({
      productKey: item.productKey,
      quantity: item.quantity,
    }));
    const promoValidation = await jsonRequest(base, '/api/promos/validate', {
      method: 'POST',
      headers: { origin: base.origin, 'sec-fetch-site': 'same-origin' },
      body: { code, items: cartIdentity },
      label: 'public promo validation',
    });
    const validatedPromo = promoValidation.payload?.promo;
    assert(promoValidation.payload?.ok === true
      && validatedPromo?.code === code
      && almostEqual(validatedPromo.merchandiseSubtotal, cart.subtotal)
      && Number(validatedPromo.discountAmount) > 0,
    'Public promo validation totals are invalid', { cartSubtotal: cart.subtotal, promo: validatedPromo });

    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const idempotencyKey = crypto.randomUUID();
    const catalogDiscount = cart.items.reduce(
      (sum, item) => sum + (item.listPrice - item.unitPrice) * item.quantity,
      0,
    );
    const expectedQuote = createOrderQuote({
      items: cart.items.map((item) => ({
        productKey: item.productKey,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        listPrice: item.listPrice,
        lineTotal: item.unitPrice * item.quantity,
      })),
      itemsSubtotal: Number(validatedPromo.merchandiseSubtotal),
      catalogDiscount,
      deliveryFee: 0,
      promoCode: code,
      promoDiscount: Number(validatedPromo.discountAmount),
      totalAmount: Number(validatedPromo.merchandiseSubtotal) - Number(validatedPromo.discountAmount),
    });
    const orderCreate = await jsonRequest(base, '/api/orders', {
      method: 'POST',
      expected: [201],
      label: 'local courier order creation',
      headers: {
        origin: base.origin,
        'sec-fetch-site': 'same-origin',
        'cf-connecting-ip': '127.0.0.1',
        'idempotency-key': idempotencyKey,
      },
      body: {
        items: cartIdentity,
        lang: 'ro',
        delivery: 'courier',
        payment: 'cash',
        promoCode: code,
        idempotencyKey,
        expectedQuote,
        customer: {
          name: 'Local Acceptance',
          phone: '+37360000000',
          email: `acceptance-${uniqueSuffix}@example.test`,
          city: 'Chisinau',
          address: 'Local loopback test address',
          comment: `Local acceptance ${uniqueSuffix}; never deliver`,
        },
      },
    });
    order = orderCreate.payload?.order;
    assert(orderCreate.payload?.ok === true && order?.id && order?.no, 'Order creation contract is invalid');
    assert(Number(order.deliveryFee) === 0, 'Courier delivery was not free at the 2200 lei pre-promo threshold', {
      merchandiseSubtotalBeforePromo: validatedPromo.merchandiseSubtotal,
      promoDiscount: order.promoDiscount,
      deliveryFee: order.deliveryFee,
    });
    assert(almostEqual(order.promoDiscount, validatedPromo.discountAmount), 'Order promo differs from public validation', {
      validated: validatedPromo.discountAmount,
      charged: order.promoDiscount,
    });
    assert(almostEqual(
      order.items.reduce((sum, item) => sum + Number(item.lineTotal), 0),
      validatedPromo.merchandiseSubtotal,
    ), 'Order item subtotal differs from the server promo subtotal');

    for (const item of cart.items) {
      const afterReservation = await availability(base, item.productKey);
      assert(afterReservation === availabilityBefore.get(item.productKey) - item.quantity,
        'Order did not reserve the expected inventory quantity', {
          productKey: item.productKey,
          before: availabilityBefore.get(item.productKey),
          afterReservation,
          quantity: item.quantity,
        });
    }

    const orderPath = `/api/admin/orders/${encodeURIComponent(order.id)}`;
    let detailResult = await poll(
      async () => jsonRequest(base, orderPath, { headers: adminHeaders(base, token), label: 'admin order detail' }),
      (result) => Array.isArray(result.payload?.order?.notifications)
        && result.payload.order.notifications.some((entry) => entry.eventType === 'order_created' && entry.status !== 'pending'),
    );
    let detail = detailResult.payload?.order;
    assert(detail?.id === order.id && detail?.promoCode === code, 'Admin order detail is invalid');
    assert(Array.isArray(detail.notifications)
      && detail.notifications.some((entry) => entry.eventType === 'order_created'),
    'Order notification history was not persisted');

    let promoDetail = (await jsonRequest(base, `/api/admin/promos/${encodeURIComponent(temporaryPromo.id)}`, {
      headers: adminHeaders(base, token),
      label: 'admin promo detail',
    })).payload?.promo;
    temporaryPromo = promoDetail || temporaryPromo;
    assert(promoDetail?.orders?.some((entry) => entry.id === order.id && !entry.releasedAt),
      'Promo detail does not contain the active order redemption');

    const internalComment = `Acceptance checked ${uniqueSuffix}`;
    const commentResult = await jsonRequest(base, `${orderPath}/internal-comment`, {
      method: 'PATCH',
      headers: adminHeaders(base, token, true),
      body: {
        comment: internalComment,
        expectedRevision: detail.internalCommentRevision ?? null,
      },
      label: 'internal order comment',
    });
    detail = commentResult.payload?.order;
    assert(detail?.internalComment === internalComment && typeof detail?.internalCommentRevision === 'string',
      'Internal comment or revision was not persisted');

    const cancelResult = await cancelOrder(base, token, order.id, 'Local acceptance cleanup');
    orderCancelled = cancelResult.payload?.order?.status === 'cancelled';
    assert(orderCancelled, 'Acceptance order was not cancelled');
    detail = cancelResult.payload.order;
    assert(detail.movements?.some((movement) => movement.type === 'reservation_release'),
      'Cancellation has no reservation_release movement');

    for (const item of cart.items) {
      const afterRelease = await availability(base, item.productKey);
      assert(afterRelease === availabilityBefore.get(item.productKey), 'Cancellation did not release inventory', {
        productKey: item.productKey,
        baseline: availabilityBefore.get(item.productKey),
        afterRelease,
      });
    }

    promoDetail = (await jsonRequest(base, `/api/admin/promos/${encodeURIComponent(temporaryPromo.id)}`, {
      headers: adminHeaders(base, token),
      label: 'released promo detail',
    })).payload?.promo;
    temporaryPromo = promoDetail || temporaryPromo;
    const redemption = promoDetail?.orders?.find((entry) => entry.id === order.id);
    assert(redemption?.releasedAt && redemption?.releaseReason && promoDetail.usageCount === 0,
      'Cancelled order did not release its promo redemption', { redemption, usageCount: promoDetail?.usageCount });

    const from = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
    const to = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
    const statistics = (await jsonRequest(
      base,
      `/api/admin/statistics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=25&offset=0`,
      { headers: adminHeaders(base, token), label: 'statistics contract' },
    )).payload;
    assert(statistics?.ok === true
      && statistics?.period?.from === from
      && statistics?.period?.to === to
      && isObject(statistics.summary)
      && Array.isArray(statistics.daily)
      && Array.isArray(statistics.products)
      && Array.isArray(statistics.categories)
      && Array.isArray(statistics.brands), 'Statistics response contract is invalid');

    const readinessResult = await jsonRequest(base, '/api/admin/health/readiness', {
      headers: adminHeaders(base, token),
      expected: [200, 503],
      label: 'readiness contract',
    });
    const readiness = readinessResult.payload;
    assert(typeof readiness?.ready === 'boolean'
      && isObject(readiness?.checks)
      && Object.values(readiness.checks).every((value) => typeof value === 'boolean')
      && readinessResult.response.status === (readiness.ready ? 200 : 503),
    'Readiness response contract or HTTP status is invalid');
    assert(Object.hasOwn(readiness.checks, 'database')
      && Object.hasOwn(readiness.checks, 'notificationJournal'),
    'Readiness response omits database journal gates');

    const cleanup = await deactivatePromo(base, token, temporaryPromo);
    temporaryPromo = cleanup?.payload?.promo || temporaryPromo;
    assert(temporaryPromo?.isActive === false, 'Temporary promo was not deactivated');

    return {
      ok: true,
      baseUrl: base.origin,
      catalog: { products: products.length, representativeProduct: representative.productKey },
      cart: {
        merchandiseSubtotalBeforePromo: validatedPromo.merchandiseSubtotal,
        promoDiscount: validatedPromo.discountAmount,
        items: cartIdentity,
      },
      order: {
        id: order.id,
        no: order.no,
        status: 'cancelled',
        deliveryFee: order.deliveryFee,
        notificationHistory: detail.notifications.length,
        internalCommentRevision: detail.internalCommentRevision,
      },
      promo: {
        id: temporaryPromo.id,
        code: temporaryPromo.code,
        active: temporaryPromo.isActive,
        redemptionReleased: true,
      },
      statistics: {
        period: statistics.period,
        productRows: statistics.products.length,
      },
      readiness,
    };
  } finally {
    if (order?.id && !orderCancelled) {
      try {
        const cleanup = await cancelOrder(base, token, order.id, 'Local acceptance failure cleanup');
        orderCancelled = cleanup.payload?.order?.status === 'cancelled';
      } catch (error) {
        cleanupErrors.push(`order ${order.id}: ${error.message}`);
      }
    }
    if (temporaryPromo?.id && temporaryPromo.isActive !== false) {
      try {
        const cleanup = await deactivatePromo(base, token, temporaryPromo);
        temporaryPromo = cleanup?.payload?.promo || temporaryPromo;
      } catch (error) {
        cleanupErrors.push(`promo ${temporaryPromo.id}: ${error.message}`);
      }
    }
    if (cleanupErrors.length) {
      console.error(`Local acceptance cleanup warning: ${cleanupErrors.join('; ')}`);
    }
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.has('--help')) {
    console.log(ACCEPTANCE_USAGE);
    return;
  }
  const reportFile = args.get('--report-file');
  if (reportFile) resolveReportFile(reportFile);
  const report = await runLocalAcceptance({
    baseUrl: String(args.get('--base-url') || DEFAULT_BASE_URL),
    adminToken: String(args.get('--admin-token') || DEFAULT_ADMIN_TOKEN),
    confirmLocalMutations: args.has('--confirm-local-mutations'),
  });
  if (reportFile) writeJsonReportFile(reportFile, report);
  process.stdout.write(serializeJsonReport(report));
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error?.message || error);
    if (error?.details && Object.keys(error.details).length) console.error(JSON.stringify(error.details, null, 2));
    console.error('\nRun with --help for local prerequisites and safety assumptions.');
    process.exitCode = 1;
  });
}
