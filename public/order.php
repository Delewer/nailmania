<?php
// Tombstone for old cPanel builds. Client-priced orders must never be accepted;
// current checkout uses POST /api/orders, where D1 validates price and stock.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
http_response_code(410);
echo json_encode([
  'ok' => false,
  'error' => [
    'code' => 'LEGACY_ORDER_ENDPOINT_DISABLED',
    'message' => 'This endpoint is disabled. Use POST /api/orders.',
  ],
]);
