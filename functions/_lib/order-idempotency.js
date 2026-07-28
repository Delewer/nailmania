const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const LOCAL_FINGERPRINT_SECRET = 'local-order-idempotency-only';

export class OrderIdempotencyError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'OrderIdempotencyError';
    this.code = code;
    this.status = status;
  }
}

export function normalizeOrderIdempotencyKey(request, body) {
  const headerKey = String(request.headers.get('idempotency-key') || '').trim();
  const bodyKey = String(body?.idempotencyKey || '').trim();
  if (headerKey && bodyKey && headerKey.toLowerCase() !== bodyKey.toLowerCase()) {
    throw new OrderIdempotencyError(
      'IDEMPOTENCY_KEY_MISMATCH',
      'Idempotency key header and body must match',
    );
  }
  const key = (headerKey || bodyKey).toLowerCase();
  if (!UUID_V4.test(key)) {
    throw new OrderIdempotencyError(
      'IDEMPOTENCY_KEY_REQUIRED',
      'A UUID v4 idempotency key is required',
      428,
    );
  }
  return key;
}

const bytesToHex = (bytes) => [...bytes]
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('');

function fingerprintSecret(env) {
  const secret = String(env?.AUTH_FINGERPRINT_SALT || '').trim();
  if (secret.length >= 16) return secret;
  if (env?.ENVIRONMENT === 'local') return LOCAL_FINGERPRINT_SECRET;
  throw new OrderIdempotencyError(
    'IDEMPOTENCY_NOT_CONFIGURED',
    'Order retry protection is temporarily unavailable',
    503,
  );
}

export async function fingerprintOrderRequest(orderRequest, customerUserId = null, env = {}) {
  const canonical = {
    version: 1,
    principal: customerUserId || null,
    items: [...orderRequest.items].sort((left, right) => left.productKey.localeCompare(right.productKey)),
    language: orderRequest.language,
    delivery: orderRequest.delivery,
    payment: orderRequest.payment,
    customer: orderRequest.customer,
    promoCode: orderRequest.promoCode || null,
    expectedQuote: orderRequest.expectedQuote,
  };
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(fingerprintSecret(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(JSON.stringify(canonical)),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function findOrderReplay(db, idempotencyKey, requestFingerprint) {
  const row = await db.prepare(`
    SELECT request_fingerprint, response_json
    FROM order_idempotency
    WHERE idempotency_key = ?
    LIMIT 1
  `).bind(idempotencyKey).first();
  if (!row) return null;
  if (row.request_fingerprint !== requestFingerprint) {
    throw new OrderIdempotencyError(
      'IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used for a different order request',
      409,
    );
  }
  let order;
  try { order = JSON.parse(row.response_json); }
  catch { order = null; }
  if (!order?.id || !order?.no || !Array.isArray(order.items)) {
    throw new OrderIdempotencyError(
      'IDEMPOTENCY_RECORD_INVALID',
      'The stored order response is invalid',
      500,
    );
  }
  return order;
}

export const isIdempotencyConstraint = (error) => /(?:UNIQUE constraint failed|SQLITE_CONSTRAINT_(?:PRIMARYKEY|UNIQUE)).*order_idempotency|order_idempotency\.idempotency_key/i
  .test(String(error?.message || error));
