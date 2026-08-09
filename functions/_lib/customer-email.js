const DELIVERY_TIMEOUT_MS = 8_000;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const EMAIL_ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export class CustomerEmailError extends Error {
  constructor(
    code = 'EMAIL_SERVICE_UNAVAILABLE',
    message = 'Email service is temporarily unavailable',
    status = 503,
    providerStatus = null,
  ) {
    super(message);
    this.name = 'CustomerEmailError';
    this.code = code;
    this.status = status;
    this.providerStatus = Number.isInteger(providerStatus) ? providerStatus : null;
  }
}

const customSender = (env, type) => {
  if (typeof env?.CUSTOMER_EMAIL_SEND === 'function') return env.CUSTOMER_EMAIL_SEND;
  if (type === 'password-reset' && typeof env?.CUSTOMER_EMAIL_SERVICE?.sendPasswordReset === 'function') {
    return (message) => env.CUSTOMER_EMAIL_SERVICE.sendPasswordReset(message);
  }
  if (type === 'order-confirmation' && typeof env?.CUSTOMER_EMAIL_SERVICE?.sendOrderConfirmation === 'function') {
    return (message) => env.CUSTOMER_EMAIL_SERVICE.sendOrderConfirmation(message);
  }
  return null;
};

const serviceFetcher = (env) => (typeof env?.CUSTOMER_EMAIL_SERVICE?.fetch === 'function'
  ? env.CUSTOMER_EMAIL_SERVICE
  : null);

function endpointUrl(env) {
  const configured = String(env?.CUSTOMER_EMAIL_ENDPOINT || '').trim();
  if (!configured) return null;
  let url;
  try { url = new URL(configured); }
  catch { return null; }
  if (env?.ENVIRONMENT !== 'local' && url.protocol !== 'https:') return null;
  return url;
}

function senderAddress(value) {
  const configured = String(value || '').trim();
  if (!configured || configured.length > 320 || /[\r\n]/.test(configured)) return '';
  const bracketed = configured.match(/<([^<>]+)>$/);
  const address = String(bracketed?.[1] || configured).trim();
  return EMAIL_ADDRESS.test(address) ? configured : '';
}

function isResendEndpoint(url) {
  return url?.toString() === RESEND_ENDPOINT;
}

function resendConfig(env, url = endpointUrl(env)) {
  if (!isResendEndpoint(url)) return null;
  const apiToken = String(env?.CUSTOMER_EMAIL_API_TOKEN || '').trim();
  const from = senderAddress(env?.CUSTOMER_EMAIL_FROM);
  return apiToken && from ? { apiToken, from } : null;
}

export function customerEmailDeliveryConfigured(env) {
  if (customSender(env, 'password-reset') || customSender(env, 'order-confirmation') || serviceFetcher(env)) return true;
  const url = endpointUrl(env);
  if (!url) return false;
  return isResendEndpoint(url) ? Boolean(resendConfig(env, url)) : true;
}

function configuredResetBase(request, env) {
  const configured = String(env?.CUSTOMER_PASSWORD_RESET_URL || '').trim();
  const fallback = env?.ENVIRONMENT === 'local' ? new URL('/reset-password', request.url).toString() : '';
  if (!configured && !fallback) {
    throw new CustomerEmailError('PASSWORD_RESET_NOT_CONFIGURED');
  }
  let url;
  try { url = new URL(configured || fallback); }
  catch { throw new CustomerEmailError('PASSWORD_RESET_NOT_CONFIGURED'); }
  if (env?.ENVIRONMENT !== 'local' && url.protocol !== 'https:') {
    throw new CustomerEmailError('PASSWORD_RESET_NOT_CONFIGURED');
  }
  return url;
}

export function assertPasswordResetEmailConfigured(request, env) {
  if (!customerEmailDeliveryConfigured(env)) throw new CustomerEmailError();
  return configuredResetBase(request, env);
}

export function passwordResetUrl(request, env, token) {
  const url = configuredResetBase(request, env);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

async function checkedFetch(fetcher, request) {
  const controller = new AbortController();
  let timeout;
  const timedOut = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new CustomerEmailError('EMAIL_TIMEOUT'));
    }, DELIVERY_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => fetcher(request, { signal: controller.signal })),
      timedOut,
    ]);
    if (!response?.ok) {
      throw new CustomerEmailError(
        'EMAIL_HTTP_ERROR',
        'Email service is temporarily unavailable',
        503,
        Number(response?.status) || null,
      );
    }
  } catch (error) {
    if (error instanceof CustomerEmailError) throw error;
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new CustomerEmailError('EMAIL_TIMEOUT');
    }
    throw new CustomerEmailError('EMAIL_NETWORK_ERROR');
  } finally {
    clearTimeout(timeout);
  }
}

async function checkedSender(sender, payload) {
  let timeout;
  const timedOut = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new CustomerEmailError('EMAIL_TIMEOUT')), DELIVERY_TIMEOUT_MS);
  });
  try {
    await Promise.race([Promise.resolve().then(() => sender(payload)), timedOut]);
  } catch (error) {
    if (error instanceof CustomerEmailError) throw error;
    throw new CustomerEmailError('EMAIL_PROVIDER_ERROR');
  } finally {
    clearTimeout(timeout);
  }
}

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

function passwordResetCopy(payload) {
  const resetUrl = String(payload.resetUrl || '');
  const safeResetUrl = escapeHtml(resetUrl);
  if (payload.locale === 'ru') {
    return {
      subject: 'Восстановление пароля Nail Mania',
      text: [
        'Вы запросили восстановление пароля аккаунта Nail Mania.',
        '',
        `Откройте ссылку: ${resetUrl}`,
        '',
        'Ссылка действует один час. Если вы не запрашивали восстановление пароля, проигнорируйте это письмо.',
      ].join('\n'),
      html: `<p>Вы запросили восстановление пароля аккаунта Nail Mania.</p><p><a href="${safeResetUrl}">Восстановить пароль</a></p><p>Ссылка действует один час. Если вы не запрашивали восстановление пароля, проигнорируйте это письмо.</p>`,
    };
  }
  return {
    subject: 'Resetarea parolei Nail Mania',
    text: [
      'Ai solicitat resetarea parolei contului Nail Mania.',
      '',
      `Deschide linkul: ${resetUrl}`,
      '',
      'Linkul este valabil timp de o oră. Dacă nu ai solicitat resetarea parolei, ignoră acest mesaj.',
    ].join('\n'),
    html: `<p>Ai solicitat resetarea parolei contului Nail Mania.</p><p><a href="${safeResetUrl}">Resetează parola</a></p><p>Linkul este valabil timp de o oră. Dacă nu ai solicitat resetarea parolei, ignoră acest mesaj.</p>`,
  };
}

const money = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toLocaleString('ro-MD', { maximumFractionDigits: 2 }) : '0';
};

function orderConfirmationCopy(payload) {
  const order = payload.order || {};
  const locale = payload.locale === 'ru' ? 'ru' : 'ro';
  const items = Array.isArray(order.items) ? order.items : [];
  const itemText = items.map((item) => (
    `${item.name} x ${item.quantity} - ${money(item.lineTotal)} lei`
  ));
  const itemRows = items.map((item) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #e5e7eb">${escapeHtml(item.name)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center">${escapeHtml(item.quantity)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap">${escapeHtml(money(item.lineTotal))} lei</td>
    </tr>`).join('');
  const discount = Number(order.discount || 0);
  const deliveryFee = Number(order.deliveryFee || 0);
  const safeOrderNo = escapeHtml(order.no);
  const summaryRows = [
    discount > 0 ? `<tr><td style="padding-top:8px">${locale === 'ru' ? 'Скидка' : 'Reducere'}</td><td style="padding-top:8px;text-align:right">-${escapeHtml(money(discount))} lei</td></tr>` : '',
    deliveryFee > 0 ? `<tr><td>${locale === 'ru' ? 'Доставка' : 'Livrare'}</td><td style="text-align:right">${escapeHtml(money(deliveryFee))} lei</td></tr>` : '',
    `<tr><td style="padding-top:8px;font-weight:700">${locale === 'ru' ? 'Итого' : 'Total'}</td><td style="padding-top:8px;text-align:right;font-weight:700">${escapeHtml(money(order.total))} lei</td></tr>`,
  ].filter(Boolean).join('');

  if (locale === 'ru') {
    return {
      subject: `Заказ ${order.no} принят`,
      text: [
        `Мы получили ваш заказ ${order.no}.`,
        'Мы свяжемся с вами для подтверждения.',
        '',
        ...itemText,
        '',
        discount > 0 ? `Скидка: -${money(discount)} lei` : '',
        deliveryFee > 0 ? `Доставка: ${money(deliveryFee)} lei` : '',
        `Итого: ${money(order.total)} lei`,
        `Способ доставки: ${order.deliveryLabel}`,
        `Оплата: ${order.paymentLabel}`,
      ].filter(Boolean).join('\n'),
      html: `<div style="font-family:Arial,sans-serif;color:#171717;max-width:640px;margin:0 auto"><h1 style="font-size:22px">Заказ ${safeOrderNo} принят</h1><p>Мы получили ваш заказ и свяжемся с вами для подтверждения.</p><table style="width:100%;border-collapse:collapse"><thead><tr><th style="padding:8px 0;text-align:left">Товар</th><th style="padding:8px 12px;text-align:center">Кол-во</th><th style="padding:8px 0;text-align:right">Сумма</th></tr></thead><tbody>${itemRows}</tbody></table><table style="width:100%;margin-top:8px">${summaryRows}</table><p><b>Способ доставки:</b> ${escapeHtml(order.deliveryLabel)}</p><p><b>Оплата:</b> ${escapeHtml(order.paymentLabel)}</p></div>`,
    };
  }
  return {
    subject: `Comanda ${order.no} a fost primită`,
    text: [
      `Am primit comanda ${order.no}.`,
      'Vă vom contacta pentru confirmare.',
      '',
      ...itemText,
      '',
      discount > 0 ? `Reducere: -${money(discount)} lei` : '',
      deliveryFee > 0 ? `Livrare: ${money(deliveryFee)} lei` : '',
      `Total: ${money(order.total)} lei`,
      `Metoda de livrare: ${order.deliveryLabel}`,
      `Plata: ${order.paymentLabel}`,
    ].filter(Boolean).join('\n'),
    html: `<div style="font-family:Arial,sans-serif;color:#171717;max-width:640px;margin:0 auto"><h1 style="font-size:22px">Comanda ${safeOrderNo} a fost primită</h1><p>Am primit comanda și vă vom contacta pentru confirmare.</p><table style="width:100%;border-collapse:collapse"><thead><tr><th style="padding:8px 0;text-align:left">Produs</th><th style="padding:8px 12px;text-align:center">Cant.</th><th style="padding:8px 0;text-align:right">Sumă</th></tr></thead><tbody>${itemRows}</tbody></table><table style="width:100%;margin-top:8px">${summaryRows}</table><p><b>Metoda de livrare:</b> ${escapeHtml(order.deliveryLabel)}</p><p><b>Plata:</b> ${escapeHtml(order.paymentLabel)}</p></div>`,
  };
}

async function sendCustomerEmail(env, payload, copy, options = {}) {
  const sender = customSender(env, payload.type);
  if (sender) {
    await checkedSender(sender, payload);
    return;
  }

  const service = serviceFetcher(env);
  if (service) {
    await checkedFetch((request, init) => service.fetch(request, init), new Request(
      `https://customer-email.internal/${payload.type}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    ));
    return;
  }

  const url = endpointUrl(env);
  if (!url) throw new CustomerEmailError();
  const headers = { 'content-type': 'application/json' };
  const apiToken = String(env?.CUSTOMER_EMAIL_API_TOKEN || '').trim();
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  let body = payload;
  const resend = resendConfig(env, url);
  if (isResendEndpoint(url)) {
    if (!resend) throw new CustomerEmailError();
    headers.accept = 'application/json';
    headers['user-agent'] = `nailmania-${payload.type}/1.0`;
    body = {
      from: resend.from,
      to: [payload.to],
      subject: copy.subject,
      text: copy.text,
      html: copy.html,
    };
    if (options.idempotencyKey) {
      headers['idempotency-key'] = String(options.idempotencyKey).slice(0, 256);
    }
  }
  const fetcher = env?.CUSTOMER_EMAIL_FETCH || fetch;
  await checkedFetch((request, init) => fetcher(request, init), new Request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }));
}

export async function sendPasswordResetEmail(env, message) {
  const payload = {
    type: 'password-reset',
    to: message.email,
    locale: message.locale === 'ru' ? 'ru' : 'ro',
    resetUrl: message.resetUrl,
    expiresAt: message.expiresAt,
  };
  await sendCustomerEmail(env, payload, passwordResetCopy(payload), {
    idempotencyKey: message.idempotencyKey,
  });
}

export async function sendOrderConfirmationEmail(env, message) {
  const payload = {
    type: 'order-confirmation',
    to: message.email,
    locale: message.locale === 'ru' ? 'ru' : 'ro',
    order: message.order,
  };
  await sendCustomerEmail(env, payload, orderConfirmationCopy(payload), {
    idempotencyKey: message.idempotencyKey,
  });
}
