<?php
// cPanel/iphost only: copy this file to `telegram.config.php` on the server and
// fill in your values. NEVER commit the real telegram.config.php (it's gitignored).
// (On Cloudflare Pages you don't need this — set TELEGRAM_BOT_TOKEN /
//  TELEGRAM_CHAT_ID as environment variables in the Pages dashboard instead.)
return [
  'token'   => 'PUT-YOUR-BOT-TOKEN-HERE',
  'chat_id' => 'PUT-YOUR-CHAT-ID-HERE',
];
