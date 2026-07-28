import { apiError, readBoundedJson } from './http.js';

const MAX_CUSTOMER_JSON_BYTES = 16 * 1024;

export async function readCustomerJson(request) {
  return readBoundedJson(request, {
    maxBytes: MAX_CUSTOMER_JSON_BYTES,
    requireObject: true,
    invalidMessage: 'Request body must be a valid JSON object',
  });
}

export function customerApiError(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
  if (status >= 500) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'customer_api.error',
      code,
      message: String(error?.message || 'Unknown error').slice(0, 300),
    }));
  }
  return apiError(code, status < 500 ? error.message : 'Internal server error', status);
}

export const turnstileToken = (body) => String(
  body?.turnstileToken ?? body?.turnstile ?? body?.['cf-turnstile-response'] ?? '',
).trim();
