import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrderRequest, OrderValidationError, priceOrder } from '../functions/_lib/order-core.js';

const validRequest = (overrides = {}) => ({
  items: [{ productKey: 'T0001', quantity: 2 }],
  customer: { name: 'Ana Test', phone: '+37368000000', city: 'Ungheni', address: 'Strada 1' },
  delivery: 'courier',
  payment: 'cash',
  lang: 'ro',
  ...overrides,
});

test('normalizes and combines duplicate cart lines', () => {
  const request = normalizeOrderRequest(validRequest({
    items: [{ productKey: 'T0001', quantity: 1 }, { productKey: 'T0001', quantity: 2 }],
  }));
  assert.deepEqual(request.items, [{ productKey: 'T0001', quantity: 3 }]);
});

test('duplicate cart lines cannot bypass the 99-unit per-product limit', () => {
  assert.throws(
    () => normalizeOrderRequest(validRequest({
      items: [{ productKey: 'T0001', quantity: 60 }, { productKey: 'T0001', quantity: 60 }],
    })),
    (error) => error instanceof OrderValidationError && error.code === 'INVALID_CART_ITEM',
  );
});

test('requires address for courier delivery', () => {
  assert.throws(
    () => normalizeOrderRequest(validRequest({ customer: { name: 'Ana', phone: '068000000' } })),
    (error) => error instanceof OrderValidationError && error.code === 'ADDRESS_REQUIRED',
  );
});

test('calculates prices from server products and delivery rules', () => {
  const request = normalizeOrderRequest(validRequest());
  const result = priceOrder(request, [{
    id: 1,
    catalog_key: 'T0001',
    sku: 'T0001',
    brand: 'Brand',
    name_ro: 'Produs',
    name_ru: 'Товар',
    price: 90,
    old_price: 100,
    on_hand: 5,
    reserved: 1,
  }]);
  assert.equal(result.itemsSubtotal, 180);
  assert.equal(result.catalogDiscount, 20);
  assert.equal(result.deliveryFee, 70);
  assert.equal(result.totalAmount, 250);
});

test('makes courier delivery free from 2200 lei inclusively', () => {
  for (const [subtotal, deliveryFee, totalAmount] of [
    [2199, 70, 2269],
    [2200, 0, 2200],
    [2201, 0, 2201],
  ]) {
    const request = normalizeOrderRequest(validRequest({
      items: [{ productKey: `P${subtotal}`, quantity: 1 }],
    }));
    const result = priceOrder(request, [{
      id: subtotal,
      catalog_key: `P${subtotal}`,
      sku: `P${subtotal}`,
      brand: 'Brand',
      name_ro: 'Produs',
      name_ru: 'Товар',
      price: subtotal,
      old_price: 0,
      on_hand: 1,
      reserved: 0,
    }]);
    assert.equal(result.deliveryFee, deliveryFee, `subtotal ${subtotal}`);
    assert.equal(result.totalAmount, totalAmount, `subtotal ${subtotal}`);
  }
});

test('keeps pickup free below the courier threshold', () => {
  const request = normalizeOrderRequest(validRequest({
    delivery: 'pickup',
    customer: { name: 'Ana Test', phone: '+37368000000' },
    items: [{ productKey: 'P2199', quantity: 1 }],
  }));
  const result = priceOrder(request, [{
    id: 2199,
    catalog_key: 'P2199',
    sku: 'P2199',
    brand: 'Brand',
    name_ro: 'Produs',
    name_ru: 'Товар',
    price: 2199,
    old_price: 0,
    on_hand: 1,
    reserved: 0,
  }]);
  assert.equal(result.deliveryFee, 0);
  assert.equal(result.totalAmount, 2199);
});

test('applies the free-delivery threshold to current prices after catalog discounts', () => {
  const request = normalizeOrderRequest(validRequest({
    items: [{ productKey: 'SALE2199', quantity: 1 }],
  }));
  const result = priceOrder(request, [{
    id: 2200,
    catalog_key: 'SALE2199',
    sku: 'SALE2199',
    brand: 'Brand',
    name_ro: 'Produs redus',
    name_ru: 'Товар со скидкой',
    price: 2199,
    old_price: 2500,
    on_hand: 1,
    reserved: 0,
  }]);
  assert.equal(result.itemsSubtotal, 2199);
  assert.equal(result.catalogDiscount, 301);
  assert.equal(result.deliveryFee, 70);
  assert.equal(result.totalAmount, 2269);
});

test('rejects an order that exceeds available stock', () => {
  const request = normalizeOrderRequest(validRequest());
  assert.throws(
    () => priceOrder(request, [{
      id: 1, catalog_key: 'T0001', sku: 'T0001', brand: '', name_ro: 'Produs', name_ru: '',
      price: 90, old_price: 0, on_hand: 2, reserved: 1,
    }]),
    (error) => error instanceof OrderValidationError && error.code === 'INSUFFICIENT_STOCK',
  );
});
