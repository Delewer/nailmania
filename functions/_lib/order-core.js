import { calculateDeliveryFee, COURIER_DELIVERY_FEE } from '../../shared/order-rules.js';
import { normalizeExpectedOrderQuote } from '../../shared/order-quote.js';

export const DELIVERY = {
  courier: { fee: COURIER_DELIVERY_FEE, ro: 'Curier', ru: 'Курьер' },
  pickup: { fee: 0, ro: 'Ridicare din magazin', ru: 'Самовывоз из магазина' },
};

export const PAYMENT = {
  mia: { ro: 'MIA', ru: 'MIA' },
  card: { ro: 'Transfer pe card', ru: 'Перевод на карту' },
  cash: { ro: 'Numerar la primire', ru: 'Наличными при получении' },
};

export class OrderValidationError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'OrderValidationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const text = (value, max) => String(value || '').trim().slice(0, max);

export function normalizeOrderRequest(input, { requireExpectedQuote = false } = {}) {
  const sourceItems = Array.isArray(input?.items) ? input.items : [];
  if (!sourceItems.length) throw new OrderValidationError('EMPTY_CART', 'Cart is empty');
  const grouped = new Map();
  for (const item of sourceItems) {
    const productKey = text(item?.productKey ?? item?.key ?? item?.sku ?? item?.id, 120);
    const quantity = Number(item?.quantity ?? item?.q);
    if (!productKey || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new OrderValidationError('INVALID_CART_ITEM', 'Each cart item must have a product key and quantity from 1 to 99');
    }
    const combinedQuantity = (grouped.get(productKey) || 0) + quantity;
    if (combinedQuantity > 99) {
      throw new OrderValidationError('INVALID_CART_ITEM', 'Each product quantity must not exceed 99');
    }
    grouped.set(productKey, combinedQuantity);
  }
  const items = [...grouped.entries()].map(([productKey, quantity]) => ({ productKey, quantity }));
  if (items.length > 50 || items.reduce((sum, item) => sum + item.quantity, 0) > 200) {
    throw new OrderValidationError('CART_TOO_LARGE', 'Cart exceeds the maximum order size');
  }

  const language = input?.lang === 'ru' ? 'ru' : 'ro';
  const delivery = text(input?.delivery, 20);
  const payment = text(input?.payment, 20);
  if (!DELIVERY[delivery]) throw new OrderValidationError('INVALID_DELIVERY', 'Invalid delivery method');
  if (!PAYMENT[payment]) throw new OrderValidationError('INVALID_PAYMENT', 'Invalid payment method');

  const sourceCustomer = input?.customer || {};
  const customer = {
    name: text(sourceCustomer.name, 120),
    phone: text(sourceCustomer.phone, 40),
    email: text(sourceCustomer.email, 180).toLowerCase(),
    city: text(sourceCustomer.city, 120),
    address: text(sourceCustomer.address, 240),
    comment: text(sourceCustomer.comment, 1000),
  };
  if (!customer.name || customer.name.length < 2) throw new OrderValidationError('INVALID_NAME', 'Customer name is required');
  if (!customer.phone || customer.phone.replace(/\D/g, '').length < 6) throw new OrderValidationError('INVALID_PHONE', 'Valid phone number is required');
  if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    throw new OrderValidationError('INVALID_EMAIL', 'Invalid email address');
  }
  if (delivery === 'courier' && (!customer.city || !customer.address)) {
    throw new OrderValidationError('ADDRESS_REQUIRED', 'City and address are required for courier delivery');
  }

  let expectedQuote = null;
  try {
    if (input?.expectedQuote) expectedQuote = normalizeExpectedOrderQuote(input.expectedQuote);
    else if (requireExpectedQuote) throw new TypeError('expectedQuote is required');
  } catch (error) {
    const missing = !input?.expectedQuote;
    throw new OrderValidationError(
      missing ? 'ORDER_QUOTE_REQUIRED' : 'INVALID_ORDER_QUOTE',
      missing ? 'The displayed order quote is required' : 'The displayed order quote is invalid',
      missing ? 428 : 400,
    );
  }

  return {
    items,
    language,
    delivery,
    payment,
    customer,
    promoCode: text(input?.promoCode, 64).toUpperCase(),
    expectedQuote,
  };
}

export function priceOrder(request, products) {
  const byKey = new Map(products.map((product) => [product.catalog_key, product]));
  const missing = request.items.filter((item) => !byKey.has(item.productKey)).map((item) => item.productKey);
  if (missing.length) throw new OrderValidationError('PRODUCT_NOT_FOUND', 'One or more products are unavailable', 409, { productKeys: missing });

  let itemsSubtotal = 0;
  let catalogDiscount = 0;
  const items = request.items.map((item) => {
    const product = byKey.get(item.productKey);
    const available = Number(product.on_hand || 0) - Number(product.reserved || 0);
    if (available < item.quantity) {
      throw new OrderValidationError('INSUFFICIENT_STOCK', 'One or more products no longer have the requested quantity', 409, {
        productKey: item.productKey,
        requested: item.quantity,
        available: Math.max(0, available),
      });
    }
    const unitPrice = Number(product.price);
    const listPrice = Number(product.old_price) > unitPrice ? Number(product.old_price) : unitPrice;
    itemsSubtotal += unitPrice * item.quantity;
    catalogDiscount += (listPrice - unitPrice) * item.quantity;
    return {
      productId: product.id,
      productKey: product.catalog_key,
      categoryId: product.category_id,
      categoryNameRo: product.category_name_ro || '',
      categoryNameRu: product.category_name_ru || '',
      costPriceSnapshot: product.cost_price == null ? null : Number(product.cost_price),
      sku: product.sku || '',
      brand: product.brand || '',
      name: request.language === 'ru' ? (product.name_ru || product.name_ro) : product.name_ro,
      unitPrice,
      listPrice,
      quantity: item.quantity,
      lineTotal: unitPrice * item.quantity,
    };
  });
  const deliveryFee = calculateDeliveryFee(request.delivery, itemsSubtotal);
  const promoDiscount = 0;
  return {
    items,
    itemsSubtotal,
    catalogDiscount,
    promoDiscount,
    deliveryFee,
    totalAmount: Math.max(0, itemsSubtotal + deliveryFee - promoDiscount),
  };
}

export const chunks = (items, size) => {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
};
