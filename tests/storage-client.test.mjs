import assert from 'node:assert/strict';
import test from 'node:test';

import { readStoredList, readStoredValue, writeStoredValue } from '../src/storage.js';

test('storefront storage helpers tolerate denied and malformed browser storage', () => {
  const denied = {
    getItem() { throw new DOMException('Denied', 'SecurityError'); },
    setItem() { throw new DOMException('Denied', 'SecurityError'); },
  };
  assert.equal(readStoredValue('nm_lang', 'ro', denied), 'ro');
  assert.deepEqual(readStoredList('nm_cart', denied), []);
  assert.equal(writeStoredValue('nm_lang', 'ru', denied), false);

  const malformed = { getItem: () => '{not-json' };
  const wrongShape = { getItem: () => '{"id":1}' };
  assert.deepEqual(readStoredList('nm_cart', malformed), []);
  assert.deepEqual(readStoredList('nm_cart', wrongShape), []);
});

test('storefront storage helpers preserve valid values and lists', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(writeStoredValue('nm_lang', 'ru', storage), true);
  assert.equal(readStoredValue('nm_lang', 'ro', storage), 'ru');
  values.set('nm_cart', JSON.stringify([{ id: 'SKU-1', q: 2 }]));
  assert.deepEqual(readStoredList('nm_cart', storage), [{ id: 'SKU-1', q: 2 }]);
});
