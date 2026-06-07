<?php
// cPanel / iphost endpoint — POST /order.php (also reached via /api/order, see .htaccess).
// Forwards a placed order to Telegram. Token is read from env or from
// telegram.config.php (which is NOT committed) — never from the page source.
header('Content-Type: application/json; charset=utf-8');

$cfg   = is_file(__DIR__ . '/telegram.config.php') ? (include __DIR__ . '/telegram.config.php') : [];
$token = getenv('TELEGRAM_BOT_TOKEN') ?: ($cfg['token']   ?? '');
$chat  = getenv('TELEGRAM_CHAT_ID')   ?: ($cfg['chat_id'] ?? '');
if (!$token || !$chat) { http_response_code(500); echo json_encode(['ok' => false, 'error' => 'not configured']); exit; }

$o = json_decode(file_get_contents('php://input'), true) ?: [];
function e($s) { return htmlspecialchars((string)$s, ENT_QUOTES | ENT_HTML5, 'UTF-8'); }

$lines = [];
foreach (($o['items'] ?? []) as $it) {
  $lines[] = '• ' . e($it['name'] ?? '') . ' × ' . ($it['q'] ?? 0) . ' — ' . (($it['price'] ?? 0) * ($it['q'] ?? 0)) . ' lei';
}
$c = $o['customer'] ?? [];
$addr = trim(implode(', ', array_filter([$c['city'] ?? '', $c['address'] ?? ''])));
$parts = array_filter([
  '🛍 <b>Новый заказ ' . e($o['no'] ?? '') . '</b>',
  '👤 ' . e($c['name'] ?? '') . ' — ' . e($c['phone'] ?? ''),
  !empty($c['email']) ? '✉️ ' . e($c['email']) : '',
  '🚚 ' . e($o['deliveryLabel'] ?? '') . ($addr ? ' — ' . e($addr) : ''),
  '💳 ' . e($o['paymentLabel'] ?? ''),
  '',
  implode("\n", $lines),
  '',
  (!empty($o['discount']) && $o['discount'] > 0) ? 'Скидка: −' . $o['discount'] . ' lei' : '',
  '<b>Итого: ' . ($o['total'] ?? 0) . ' lei</b>',
  !empty($c['comment']) ? '📝 ' . e($c['comment']) : '',
]);
$payload = json_encode([
  'chat_id' => $chat, 'text' => implode("\n", $parts),
  'parse_mode' => 'HTML', 'disable_web_page_preview' => true,
]);

$ch = curl_init("https://api.telegram.org/bot{$token}/sendMessage");
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
  CURLOPT_POSTFIELDS => $payload, CURLOPT_TIMEOUT => 10,
]);
$res = curl_exec($ch);
echo json_encode(['ok' => ($res !== false && strpos($res, '"ok":true') !== false)]);
