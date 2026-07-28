const STORAGE_KEY = 'nm_checkout_attempt_id';
const LEGACY_GUEST_ORDERS_KEY = 'nm_orders';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const availableStorage = (storage) => {
  try { return storage || globalThis.localStorage || null; }
  catch { return null; }
};

const generateOrderAttemptKey = (randomUUID) => {
  const generate = randomUUID || (() => globalThis.crypto.randomUUID());
  const key = String(generate()).toLowerCase();
  if (!UUID_V4.test(key)) throw new TypeError('Order idempotency generator did not return a UUID v4');
  return key;
};

export function getOrCreateOrderAttemptKey({ storage, randomUUID } = {}) {
  const target = availableStorage(storage);
  try {
    const existing = String(target?.getItem(STORAGE_KEY) || '').trim().toLowerCase();
    if (UUID_V4.test(existing)) return existing;
  } catch { /* storage may be denied; the in-memory caller still keeps the key */ }
  const key = generateOrderAttemptKey(randomUUID);
  try { target?.setItem(STORAGE_KEY, key); }
  catch { /* storage is optional */ }
  return key;
}

export function startNewOrderAttemptKey({ storage, randomUUID } = {}) {
  const target = availableStorage(storage);
  const key = generateOrderAttemptKey(randomUUID);
  try { target?.setItem(STORAGE_KEY, key); }
  catch { /* storage is optional; the caller retains the returned key in memory */ }
  return key;
}

export function completeOrderAttemptKey(key, { storage } = {}) {
  const target = availableStorage(storage);
  try {
    if (String(target?.getItem(STORAGE_KEY) || '').toLowerCase() === String(key || '').toLowerCase()) {
      target.removeItem(STORAGE_KEY);
    }
  } catch { /* storage is optional */ }
}

export function purgeLegacyGuestOrderHistory({ storage } = {}) {
  const target = availableStorage(storage);
  try { target?.removeItem(LEGACY_GUEST_ORDERS_KEY); }
  catch { /* storage is optional */ }
}

export { STORAGE_KEY as ORDER_ATTEMPT_STORAGE_KEY };
