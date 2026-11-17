import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MANUAL_ADDRESS_VALUE,
  SAVED_ADDRESS_FORM_FIELDS,
  savedAddressCheckoutFields,
} from '../src/checkout-address.js';

test('saved checkout address maps only the editable public fields', () => {
  assert.equal(MANUAL_ADDRESS_VALUE, '__manual__');
  assert.deepEqual([...SAVED_ADDRESS_FORM_FIELDS], ['name', 'phone', 'city', 'address', 'comment']);
  assert.deepEqual(savedAddressCheckoutFields({
    id: 'address-secret-id',
    recipientName: 'Ana',
    phone: '+373 60 123 456',
    city: 'Chișinău',
    address: 'str. Test 1',
    comment: 'Etajul 2',
    isDefault: true,
  }), {
    name: 'Ana',
    phone: '60123456',
    city: 'Chișinău',
    address: 'str. Test 1',
    comment: 'Etajul 2',
  });
});

test('saved checkout address tolerates missing optional values', () => {
  assert.deepEqual(savedAddressCheckoutFields(null), {
    name: '', phone: '', city: '', address: '', comment: '',
  });
});
