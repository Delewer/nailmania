export const MOLDOVA_COUNTRY_CODE = '+373';

const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '');

export function moldovaLocalPhone(value) {
  const digits = digitsOnly(value);
  if (/^373[1-9]\d{7}$/.test(digits)) return digits.slice(3);
  if (/^0[1-9]\d{7}$/.test(digits)) return digits.slice(1);
  if (/^[1-9]\d{7}$/.test(digits)) return digits;
  return '';
}

export function sanitizeMoldovaPhoneInput(value) {
  let digits = digitsOnly(value);
  if (digits.startsWith('373') && digits.length > 8) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits.slice(0, 8);
}

export function normalizeMoldovaPhone(value) {
  const local = moldovaLocalPhone(value);
  return local ? `${MOLDOVA_COUNTRY_CODE}${local}` : '';
}
