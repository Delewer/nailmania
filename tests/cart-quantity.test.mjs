import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CART_LINE_CAP,
  cartLineLimit,
  clampCartQuantity,
  incrementCartQuantity,
  normalizeCartIncrement,
  reconcileCartItems,
} from '../src/cart-quantity.js';

const source = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('cart line limit combines current stock with the 99 unit cap', () => {
  assert.equal(CART_LINE_CAP, 99);
  assert.equal(cartLineLimit({ stock: 3.9 }), 3);
  assert.equal(cartLineLimit({ stock: 0 }), 0);
  assert.equal(cartLineLimit({ stock: 250 }), 99);
  assert.equal(cartLineLimit({}), 99);
  assert.equal(cartLineLimit({ stock: Number.NaN }), 99);

  assert.equal(normalizeCartIncrement('7.8'), 7);
  assert.equal(normalizeCartIncrement(150), 99);
  assert.equal(normalizeCartIncrement('invalid', 1), 1);
  assert.equal(clampCartQuantity(8, { stock: 5 }), 5);
  assert.equal(clampCartQuantity(100, { stock: 200 }), 99);
  assert.equal(clampCartQuantity(-1, { stock: 5 }), 0);
});

test('incrementing a cart line cannot cross stock or the global line cap', () => {
  assert.equal(incrementCartQuantity(2, 4, { stock: 5 }), 5);
  assert.equal(incrementCartQuantity(98, 10, { stock: 500 }), 99);
  assert.equal(incrementCartQuantity(4, 1, { stock: 0 }), 0);
  assert.equal(incrementCartQuantity(20, 1, { stock: 3 }), 3);
});

test('catalog reconciliation clamps reduced stock, removes stock zero, and merges legacy duplicates', () => {
  const products = new Map([
    ['limited', { key: 'limited', stock: 2 }],
    ['sold-out', { key: 'sold-out', stock: 0 }],
    ['large', { key: 'large', stock: 500 }],
  ]);
  const cart = [
    { id: 'limited', q: 1 },
    { id: 'limited', q: 5 },
    { id: 'sold-out', q: 1 },
    { id: 'large', q: 150 },
    { id: 'removed', q: 4 },
  ];

  assert.deepEqual(reconcileCartItems(cart, (key) => products.get(key)), [
    { id: 'limited', q: 2 },
    { id: 'large', q: 99 },
  ]);
  assert.deepEqual(reconcileCartItems(cart, (key) => products.get(key), { keepUnresolved: true }), [
    { id: 'limited', q: 2 },
    { id: 'large', q: 99 },
    { id: 'removed', q: 4 },
  ]);
});

test('store, product page, and checkout wire the shared stock limit into add and plus controls', () => {
  const shop = source('src/shop.jsx');
  const productPage = source('src/pages/ProductPage.jsx');
  const checkout = source('src/pages/Checkout.jsx');
  const menus = source('src/components/Menus.jsx');
  const data = source('src/data.js');

  assert.match(shop, /incrementCartQuantity\(currentQuantity,quantity,product\)/);
  assert.match(shop, /const quantity = clampCartQuantity\(q,product\)/);
  assert.match(shop, /keepUnresolved:!catalogLoaded \|\| Boolean\(catalogError\)/);
  assert.match(productPage, /disabled=\{qty>=maxSelectable\}/);
  assert.match(productPage, /disabled=\{atCartLimit\}/);
  assert.match(checkout, /disabled=\{atLineLimit\}/);
  assert.match(menus, /const atLineLimit = item\.q>=cartLineLimit\(p\)/);
  assert.match(menus, /disabled=\{atLineLimit\}/);
  assert.match(data, /stockLimitReached:/);
});
