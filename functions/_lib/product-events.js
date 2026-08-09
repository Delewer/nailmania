const EVENT_TYPES = new Set([
  'product_view', 'add_to_cart', 'search', 'checkout_started', 'order_created',
]);
const SOURCES = new Set([
  'product_page', 'product_card', 'favorites', 'cart', 'checkout', 'search',
  'repeat_order', 'unknown',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const BASE_KEYS = new Set(['event', 'anonymousId', 'language', 'source']);
const EVENT_KEYS = Object.freeze({
  product_view: new Set([...BASE_KEYS, 'productKey']),
  add_to_cart: new Set([...BASE_KEYS, 'productKey', 'quantity']),
  search: new Set([...BASE_KEYS, 'resultCount', 'queryLength']),
  checkout_started: new Set([...BASE_KEYS, 'itemCount', 'value']),
  order_created: new Set([...BASE_KEYS, 'itemCount', 'value']),
});

export const PRODUCT_EVENT_LAYOUT = Object.freeze({
  blobs: Object.freeze(['event', 'product_key', 'category_id', 'brand', 'language', 'source']),
  doubles: Object.freeze(['count', 'quantity_or_item_count', 'value_lei', 'result_count', 'query_length']),
  indexes: Object.freeze(['daily_hmac_of_anonymous_browser_id']),
});

export class ProductEventError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'ProductEventError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function requireProductEventSameOrigin(request, env) {
  const origin = request.headers.get('origin');
  const fetchSite = String(request.headers.get('sec-fetch-site') || '').toLowerCase();
  if (!origin) {
    if (env?.ENVIRONMENT === 'local') return;
    throw new ProductEventError('EVENT_ORIGIN_REQUIRED', 'Product events require a same-origin request', 403);
  }
  let sameOrigin = false;
  try { sameOrigin = new URL(origin).origin === new URL(request.url).origin; }
  catch { sameOrigin = false; }
  if (!sameOrigin || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
    throw new ProductEventError('CROSS_ORIGIN_EVENT', 'Cross-origin product events are not accepted', 403);
  }
}

const boundedText = (value, max) => String(value ?? '').trim().slice(0, max);
const integer = (value, field, { min = 0, max = 10_000_000 } = {}) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ProductEventError('INVALID_EVENT_FIELD', `${field} must be an integer from ${min} to ${max}`, 400, { field });
  }
  return parsed;
};

export function normalizeProductEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProductEventError('INVALID_EVENT', 'Event body must be a JSON object');
  }
  const event = boundedText(input.event, 40).toLowerCase();
  if (!EVENT_TYPES.has(event)) throw new ProductEventError('INVALID_EVENT_TYPE', 'Unknown product analytics event type');
  const allowed = EVENT_KEYS[event];
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new ProductEventError('INVALID_EVENT_FIELD', 'Event contains fields that are not allowed for this type', 400, { fields: unknown });
  }
  const anonymousId = boundedText(input.anonymousId, 64);
  if (!UUID.test(anonymousId)) {
    throw new ProductEventError('INVALID_ANONYMOUS_ID', 'A random anonymous browser UUID is required');
  }
  const language = boundedText(input.language, 2).toLowerCase();
  if (!['ro', 'ru'].includes(language)) throw new ProductEventError('INVALID_EVENT_FIELD', 'language must be ro or ru', 400, { field: 'language' });
  const source = boundedText(input.source || 'unknown', 40).toLowerCase();
  if (!SOURCES.has(source)) throw new ProductEventError('INVALID_EVENT_FIELD', 'Unknown event source', 400, { field: 'source' });

  const normalized = {
    event,
    anonymousId: anonymousId.toLowerCase(),
    language,
    source,
    productKey: '',
    quantity: 0,
    itemCount: 0,
    value: 0,
    resultCount: 0,
    queryLength: 0,
  };
  if (event === 'product_view' || event === 'add_to_cart') {
    normalized.productKey = boundedText(input.productKey, 120);
    if (!PRODUCT_KEY.test(normalized.productKey)) {
      throw new ProductEventError('INVALID_EVENT_FIELD', 'productKey is invalid', 400, { field: 'productKey' });
    }
  }
  if (event === 'add_to_cart') normalized.quantity = integer(input.quantity, 'quantity', { min: 1, max: 99 });
  if (event === 'search') {
    normalized.resultCount = integer(input.resultCount, 'resultCount', { min: 0, max: 100_000 });
    // The query itself is deliberately never accepted. Only its length is
    // retained, so accidental emails, phone numbers or names cannot be stored.
    normalized.queryLength = integer(input.queryLength, 'queryLength', { min: 0, max: 500 });
  }
  if (event === 'checkout_started' || event === 'order_created') {
    normalized.itemCount = integer(input.itemCount, 'itemCount', { min: 1, max: 200 });
    normalized.value = integer(input.value, 'value', { min: 0, max: 10_000_000 });
  }
  return normalized;
}

async function dailyAnonymousIndex(env, anonymousId, now) {
  const secret = boundedText(env?.ANALYTICS_INDEX_SECRET || env?.RATE_LIMIT_SECRET, 1000);
  if (secret.length < 16) {
    throw new ProductEventError('ANALYTICS_NOT_CONFIGURED', 'Product analytics is temporarily unavailable', 503);
  }
  const day = now.toISOString().slice(0, 10);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${day}\0${anonymousId}`)));
  const index = [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (encoder.encode(index).byteLength > 96) throw new Error('Anonymous Analytics Engine index exceeds 96 bytes');
  return index;
}

async function productDimensions(db, productKey) {
  if (!productKey) return { key: '', category: '', brand: '', price: 0 };
  const row = await db.prepare(`
    SELECT product.catalog_key, product.category_id, product.brand,
           prices.effective_price AS price
    FROM products product
    JOIN product_catalog_prices prices ON prices.product_id = product.id
    WHERE product.catalog_key = ? AND product.is_active = 1 AND product.deleted_at IS NULL
  `).bind(productKey).first();
  if (!row) throw new ProductEventError('EVENT_PRODUCT_NOT_FOUND', 'Product is unavailable', 422);
  return {
    key: boundedText(row.catalog_key, 120),
    category: boundedText(row.category_id, 100),
    brand: boundedText(row.brand, 180),
    price: integer(row.price, 'price', { min: 0, max: 10_000_000 }),
  };
}

async function prepareProductEvent({ db, input }) {
  const event = normalizeProductEvent(input);
  const product = await productDimensions(db, event.productKey);
  const quantityOrItems = event.event === 'add_to_cart' ? event.quantity : event.itemCount;
  const value = event.event === 'add_to_cart' ? product.price * event.quantity : event.value;
  return { event, product, quantityOrItems, value };
}

const analyticsPoint = ({ event, product, quantityOrItems, value }, index) => ({
  blobs: [event.event, product.key, product.category, product.brand, event.language, event.source],
  doubles: [1, quantityOrItems, value, event.resultCount, event.queryLength],
  indexes: [index],
});

export async function prepareProductDataPoint({ db, env, input, now = new Date() }) {
  const prepared = await prepareProductEvent({ db, input });
  const index = await dailyAnonymousIndex(env, prepared.event.anonymousId, now);
  return {
    event: prepared.event,
    point: analyticsPoint(prepared, index),
  };
}

async function recordDailyProductEvent(db, prepared, now) {
  if (prepared.event.event === 'order_created') return false;
  await db.prepare(`
    INSERT INTO product_event_daily (
      event_day, event_type, event_count, quantity_or_items,
      value_lei, result_count, updated_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(event_day, event_type) DO UPDATE SET
      event_count = product_event_daily.event_count + excluded.event_count,
      quantity_or_items = product_event_daily.quantity_or_items + excluded.quantity_or_items,
      value_lei = product_event_daily.value_lei + excluded.value_lei,
      result_count = product_event_daily.result_count + excluded.result_count,
      updated_at = excluded.updated_at
  `).bind(
    now.toISOString().slice(0, 10),
    prepared.event.event,
    prepared.quantityOrItems,
    prepared.value,
    prepared.event.resultCount,
    now.toISOString(),
  ).run();
  return true;
}

export async function recordProductEvent({ db, env, input, now = new Date() }) {
  const prepared = await prepareProductEvent({ db, input });
  const d1Recorded = await recordDailyProductEvent(db, prepared, now);
  let analyticsEngineRecorded = false;
  if (env?.PRODUCT_ANALYTICS?.writeDataPoint) {
    try {
      const index = await dailyAnonymousIndex(env, prepared.event.anonymousId, now);
      env.PRODUCT_ANALYTICS.writeDataPoint(analyticsPoint(prepared, index));
      analyticsEngineRecorded = true;
    } catch (error) {
      if (!d1Recorded) throw error;
    }
  }
  const recorded = d1Recorded || analyticsEngineRecorded;
  return {
    configured: recorded,
    recorded,
    ...(recorded ? { event: prepared.event.event } : {}),
  };
}
