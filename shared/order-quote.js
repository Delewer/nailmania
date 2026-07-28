export const ORDER_QUOTE_VERSION = 1;
export const ORDER_CURRENCY = 'MDL';

const asInteger = (value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`${label} must be an integer from ${min} to ${max}`);
  }
  return parsed;
};

const asProductKey = (value) => {
  const key = String(value || '').trim().slice(0, 120);
  if (!key) throw new TypeError('quote item productKey is required');
  return key;
};

const normalizePromoCode = (value) => {
  const code = String(value || '').trim().toUpperCase().slice(0, 64);
  return code || null;
};

// Two independent 32-bit FNV-1a passes keep the synchronous client contract
// compact. The revision is only a fast snapshot identifier: the server still
// compares every normalized field, so correctness never depends on hash
// collision resistance.
function quoteRevision(value) {
  const source = JSON.stringify(value);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `q${ORDER_QUOTE_VERSION}-${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`;
}

export function createOrderQuote(input) {
  const sourceItems = Array.isArray(input?.items) ? input.items : [];
  if (!sourceItems.length || sourceItems.length > 50) {
    throw new TypeError('quote must contain from 1 to 50 items');
  }
  const seen = new Set();
  const items = sourceItems.map((item) => {
    const productKey = asProductKey(item?.productKey);
    if (seen.has(productKey)) throw new TypeError('quote product keys must be unique');
    seen.add(productKey);
    const quantity = asInteger(item?.quantity, 'quote item quantity', { min: 1, max: 99 });
    const unitPrice = asInteger(item?.unitPrice, 'quote item unitPrice');
    const listPrice = asInteger(item?.listPrice, 'quote item listPrice', { min: unitPrice });
    const lineTotal = asInteger(item?.lineTotal, 'quote item lineTotal');
    if (lineTotal !== unitPrice * quantity) throw new TypeError('quote item lineTotal is inconsistent');
    return { productKey, quantity, unitPrice, listPrice, lineTotal };
  }).sort((left, right) => left.productKey.localeCompare(right.productKey));

  const fields = {
    version: ORDER_QUOTE_VERSION,
    currency: ORDER_CURRENCY,
    items,
    itemsSubtotal: asInteger(input?.itemsSubtotal, 'quote itemsSubtotal'),
    catalogDiscount: asInteger(input?.catalogDiscount, 'quote catalogDiscount'),
    deliveryFee: asInteger(input?.deliveryFee, 'quote deliveryFee'),
    promoCode: normalizePromoCode(input?.promoCode),
    promoDiscount: asInteger(input?.promoDiscount, 'quote promoDiscount'),
    totalAmount: asInteger(input?.totalAmount, 'quote totalAmount'),
  };
  if (fields.totalAmount !== Math.max(0, fields.itemsSubtotal + fields.deliveryFee - fields.promoDiscount)) {
    throw new TypeError('quote totalAmount is inconsistent');
  }
  return {
    version: fields.version,
    currency: fields.currency,
    revision: quoteRevision(fields),
    items: fields.items,
    itemsSubtotal: fields.itemsSubtotal,
    catalogDiscount: fields.catalogDiscount,
    deliveryFee: fields.deliveryFee,
    promoCode: fields.promoCode,
    promoDiscount: fields.promoDiscount,
    totalAmount: fields.totalAmount,
  };
}

export function normalizeExpectedOrderQuote(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('expectedQuote is required');
  }
  if (input.version !== ORDER_QUOTE_VERSION || input.currency !== ORDER_CURRENCY) {
    throw new TypeError('expectedQuote version or currency is invalid');
  }
  const normalized = createOrderQuote(input);
  if (input.revision !== normalized.revision) throw new TypeError('expectedQuote revision is invalid');
  return normalized;
}

export const orderQuotesEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);
