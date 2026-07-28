export const CART_LINE_CAP = 99;

export function cartLineLimit(product) {
  const stock = product?.stock;
  if (typeof stock !== "number" || !Number.isFinite(stock)) return CART_LINE_CAP;
  return Math.min(CART_LINE_CAP, Math.max(0, Math.floor(stock)));
}

export function normalizeCartIncrement(value, fallback = 0) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) return fallback;
  return Math.min(CART_LINE_CAP, Math.floor(quantity));
}

export function clampCartQuantity(value, product) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return Math.min(cartLineLimit(product), Math.floor(quantity));
}

export function incrementCartQuantity(current, increment, product) {
  const present = clampCartQuantity(current, product);
  const requested = normalizeCartIncrement(increment);
  return clampCartQuantity(present + requested, product);
}

export function reconcileCartItems(items, resolveProduct, { keepUnresolved = false } = {}) {
  if (!Array.isArray(items)) return [];

  const next = [];
  const positions = new Map();
  for (const item of items) {
    const id = item?.id;
    if ((typeof id !== "string" && typeof id !== "number") || id === "") continue;

    const product = typeof resolveProduct === "function" ? resolveProduct(id) : null;
    if (!product && !keepUnresolved) continue;

    const position = positions.get(id);
    const present = position === undefined ? 0 : next[position].q;
    const quantity = incrementCartQuantity(present, item.q, product);
    if (quantity <= 0) continue;

    if (position === undefined) {
      positions.set(id, next.length);
      next.push({ id, q: quantity });
    } else {
      next[position] = { id, q: quantity };
    }
  }
  return next;
}
