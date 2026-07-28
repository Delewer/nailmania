import { apiError } from '../_lib/http.js';

// Tombstone for the former client-priced Telegram endpoint. Keeping the route
// explicit prevents stale clients from receiving the SPA HTML and treating it
// as success, while all real orders must go through POST /api/orders and D1.
export function onRequest() {
  return apiError(
    'LEGACY_ORDER_ENDPOINT_DISABLED',
    'This endpoint is disabled. Use POST /api/orders.',
    410,
  );
}
