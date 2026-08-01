const DEFAULT_TIMEOUT_MS = 8_000;

export class TelegramDeliveryError extends Error {
  constructor(code, providerStatus = null) {
    super('Telegram notification could not be delivered');
    this.name = 'TelegramDeliveryError';
    this.code = code;
    this.providerStatus = Number.isInteger(providerStatus) ? providerStatus : null;
  }
}

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

function telegramMessage(env, order) {
  const items = order.items
    .map((item) => `• ${escapeHtml(item.name)} × ${item.quantity} — ${item.lineTotal} lei`)
    .join('\n');
  const address = [order.customer.city, order.customer.address].filter(Boolean).join(', ');
  const previewLabel = String(env?.ENVIRONMENT || '').trim().toLowerCase() === 'preview'
    ? '🧪 <b>ТЕСТОВЫЙ ЗАКАЗ — НЕ ОБРАБАТЫВАТЬ</b>'
    : '';
  return [
    previewLabel,
    `🛍 <b>Новый заказ ${escapeHtml(order.no)}</b>`,
    `👤 ${escapeHtml(order.customer.name)} — ${escapeHtml(order.customer.phone)}`,
    order.customer.email ? `✉️ ${escapeHtml(order.customer.email)}` : '',
    `🚚 ${escapeHtml(order.deliveryLabel)}${address ? ` — ${escapeHtml(address)}` : ''}`,
    `💳 ${escapeHtml(order.paymentLabel)}`,
    '',
    items,
    '',
    order.discount > 0 ? `Скидка: −${order.discount} lei` : '',
    order.deliveryFee > 0 ? `Доставка: ${order.deliveryFee} lei` : '',
    `<b>Итого: ${order.total} lei</b>`,
    order.customer.comment ? `📝 ${escapeHtml(order.customer.comment)}` : '',
  ].filter(Boolean).join('\n');
}

function deliveryTimeout(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 30_000 ? parsed : DEFAULT_TIMEOUT_MS;
}

async function fetchWithTimeout(fetcher, url, init, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TelegramDeliveryError('TELEGRAM_TIMEOUT'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => fetcher(url, { ...init, signal: controller.signal })),
      timeout,
    ]);
  } catch (error) {
    if (error instanceof TelegramDeliveryError) throw error;
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new TelegramDeliveryError('TELEGRAM_TIMEOUT');
    }
    throw new TelegramDeliveryError('TELEGRAM_NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
  }
}

export async function sendTelegramOrder(env, order, options = {}) {
  const token = String(env?.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env?.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) throw new TelegramDeliveryError('TELEGRAM_NOT_CONFIGURED');

  const fetcher = env?.TELEGRAM_FETCH || fetch;
  const response = await fetchWithTimeout(
    fetcher,
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: telegramMessage(env, order),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    },
    deliveryTimeout(options.timeoutMs ?? env?.TELEGRAM_TIMEOUT_MS),
  );
  if (!response?.ok) {
    throw new TelegramDeliveryError('TELEGRAM_HTTP_ERROR', Number(response?.status) || null);
  }
  if (String(response.headers?.get?.('content-type') || '').includes('application/json')) {
    try {
      const payload = await response.clone().json();
      if (payload?.ok === false) {
        throw new TelegramDeliveryError('TELEGRAM_PROVIDER_REJECTED', Number(response.status) || null);
      }
    } catch (error) {
      if (error instanceof TelegramDeliveryError) throw error;
      // A successful HTTP response with a non-JSON/invalid optional body is still
      // considered delivered. Provider response text is never logged or stored.
    }
  }
  return { ok: true, providerStatus: Number(response.status) || 200 };
}

// Kept as a narrow compatibility wrapper for callers outside the order pipeline.
export async function notifyTelegram(env, order, options) {
  return sendTelegramOrder(env, order, options);
}
