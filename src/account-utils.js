export const OFFICIAL_TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";

export function resolveTurnstileSiteKey({ configuredKey = "", isDevelopment = false, isTest = false } = {}) {
  const key = String(configuredKey || "").trim();
  const allowTestKey = isDevelopment || isTest;
  if (key && (key !== OFFICIAL_TURNSTILE_TEST_SITE_KEY || allowTestKey)) {
    return { key, isTestKey: key === OFFICIAL_TURNSTILE_TEST_SITE_KEY, configured: true };
  }
  if (allowTestKey) {
    return { key: OFFICIAL_TURNSTILE_TEST_SITE_KEY, isTestKey: true, configured: true };
  }
  return { key: "", isTestKey: false, configured: false };
}

export function resetTokenFromHash(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  if (!raw) return "";
  let token = "";
  try {
    const params = new URLSearchParams(raw);
    token = String(params.get("token") || "").trim();
  } catch { return ""; }
  return /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : "";
}

export function safeNextPath(value, fallback = "/account") {
  const next = String(value || "").trim();
  if (!next.startsWith("/") || next.startsWith("//") || /[\r\n]/.test(next)) return fallback;
  return next;
}

const positiveInteger = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
};

export function planRepeatOrder(orderItems, products, existingCart = []) {
  const productMap = new Map((products || [])
    .filter((product) => product && typeof product.key === "string")
    .map((product) => [product.key, product]));
  const existing = new Map((existingCart || []).map((item) => [String(item.id), positiveInteger(item.q)]));
  const requested = new Map();
  for (const item of orderItems || []) {
    const key = String(item?.productKey || "").trim();
    if (!key) continue;
    requested.set(key, (requested.get(key) || 0) + positiveInteger(item.quantity));
  }

  const entries = [];
  const unavailable = [];
  const adjusted = [];
  for (const [productKey, quantity] of requested) {
    const product = productMap.get(productKey);
    const stock = positiveInteger(product?.stock);
    const room = Math.max(0, stock - (existing.get(productKey) || 0));
    const addQuantity = Math.min(quantity, room);
    if (!product || stock < 1 || addQuantity < 1) {
      unavailable.push({ productKey, quantity });
      continue;
    }
    entries.push({ product, quantity: addQuantity });
    if (addQuantity < quantity) adjusted.push({ productKey, requested: quantity, added: addQuantity });
  }
  return { entries, unavailable, adjusted };
}
