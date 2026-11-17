import { moldovaLocalPhone } from '../shared/moldova-phone.js';

export const MANUAL_ADDRESS_VALUE = '__manual__';
export const SAVED_ADDRESS_FORM_FIELDS = Object.freeze([
  'name', 'phone', 'city', 'address', 'comment',
]);

export function savedAddressCheckoutFields(address) {
  return {
    name: String(address?.recipientName || ''),
    phone: moldovaLocalPhone(address?.phone),
    city: String(address?.city || ''),
    address: String(address?.address || ''),
    comment: String(address?.comment || ''),
  };
}
