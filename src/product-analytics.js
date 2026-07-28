const STORAGE_KEY = 'nm_analytics_id';
const CLIENT_EVENTS = new Set(['product_view', 'add_to_cart', 'search', 'checkout_started']);

function randomUuid(cryptoObject = globalThis.crypto) {
  if (typeof cryptoObject?.randomUUID === 'function') return cryptoObject.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoObject?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function analyticsAnonymousId(storage = globalThis.localStorage, cryptoObject = globalThis.crypto) {
  try {
    const current = String(storage?.getItem?.(STORAGE_KEY) || '');
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(current)) return current;
    const created = randomUuid(cryptoObject);
    storage?.setItem?.(STORAGE_KEY, created);
    return created;
  } catch {
    return randomUuid(cryptoObject);
  }
}

export function buildClientProductEvent(event, fields = {}, dependencies = {}) {
  if (!CLIENT_EVENTS.has(event)) throw new Error(`Client analytics event is not allowed: ${event}`);
  return {
    event,
    anonymousId: analyticsAnonymousId(dependencies.storage, dependencies.crypto),
    language: fields.language === 'ru' ? 'ru' : 'ro',
    source: fields.source || 'unknown',
    ...(event === 'product_view' ? { productKey: fields.productKey } : {}),
    ...(event === 'add_to_cart' ? { productKey: fields.productKey, quantity: fields.quantity } : {}),
    ...(event === 'search' ? { resultCount: fields.resultCount, queryLength: fields.queryLength } : {}),
    ...(event === 'checkout_started' ? { itemCount: fields.itemCount, value: fields.value } : {}),
  };
}

export function trackProductEvent(event, fields = {}, dependencies = {}) {
  let body;
  try { body = JSON.stringify(buildClientProductEvent(event, fields, dependencies)); }
  catch { return false; }
  const navigatorObject = dependencies.navigator ?? globalThis.navigator;
  try {
    if (typeof navigatorObject?.sendBeacon === 'function') {
      const accepted = navigatorObject.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }));
      if (accepted) return true;
    }
  } catch {}
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetcher !== 'function') return false;
  Promise.resolve(fetcher('/api/events', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body,
  })).catch(() => {});
  return true;
}
