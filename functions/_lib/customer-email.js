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
  if (['order-confirmation', 'order-notification'].includes(type)
      && typeof env?.CUSTOMER_EMAIL_SERVICE?.sendOrderNotification === 'function') {
    return (message) => env.CUSTOMER_EMAIL_SERVICE.sendOrderNotification(message);
  }
  if (['order-confirmation', 'order-notification'].includes(type)
      && typeof env?.CUSTOMER_EMAIL_SERVICE?.sendOrderConfirmation === 'function') {
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
  if (customSender(env, 'password-reset') || customSender(env, 'order-notification') || serviceFetcher(env)) return true;
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

const ORDER_EMAIL_EVENTS = new Set([
  'order_created',
  'order_confirmed',
  'order_cancelled',
  'order_returned',
]);

const orderEventCopy = (locale, eventType, orderNo) => {
  const ru = locale === 'ru';
  const copy = {
    order_created: ru ? {
      subject: `Заказ ${orderNo} принят`, status: 'Заказ получен', color: '#c2557a',
      title: 'Спасибо за заказ!',
      intro: 'Мы получили ваш заказ и свяжемся с вами для подтверждения.',
    } : {
      subject: `Comanda ${orderNo} a fost primită`, status: 'Comandă primită', color: '#c2557a',
      title: 'Vă mulțumim pentru comandă!',
      intro: 'Am primit comanda și vă vom contacta pentru confirmare.',
    },
    order_confirmed: ru ? {
      subject: `Заказ ${orderNo} подтверждён`, status: 'Заказ подтверждён', color: '#236247',
      title: 'Ваш заказ подтверждён',
      intro: 'Мы подтвердили заказ. Если потребуются дополнительные детали, мы свяжемся с вами.',
    } : {
      subject: `Comanda ${orderNo} a fost confirmată`, status: 'Comandă confirmată', color: '#236247',
      title: 'Comanda a fost confirmată',
      intro: 'Am confirmat comanda. Dacă avem nevoie de detalii suplimentare, vă vom contacta.',
    },
    order_cancelled: ru ? {
      subject: `Заказ ${orderNo} отменён`, status: 'Заказ отменён', color: '#8b3f50',
      title: 'Заказ отменён',
      intro: 'Заказ был отменён. Если у вас есть вопросы, пожалуйста, свяжитесь с нами.',
    } : {
      subject: `Comanda ${orderNo} a fost anulată`, status: 'Comandă anulată', color: '#8b3f50',
      title: 'Comanda a fost anulată',
      intro: 'Comanda a fost anulată. Dacă aveți întrebări, vă rugăm să ne contactați.',
    },
    order_returned: ru ? {
      subject: `Возврат по заказу ${orderNo} зарегистрирован`, status: 'Возврат зарегистрирован', color: '#804d20',
      title: 'Мы зарегистрировали возврат',
      intro: 'Возврат товаров зарегистрирован. Это сообщение не является подтверждением банковской выплаты.',
    } : {
      subject: `Returul pentru comanda ${orderNo} a fost înregistrat`, status: 'Retur înregistrat', color: '#804d20',
      title: 'Am înregistrat returul',
      intro: 'Returul produselor a fost înregistrat. Acest mesaj nu confirmă efectuarea unei plăți bancare.',
    },
  };
  return copy[eventType] || copy.order_created;
};

const safeSiteUrl = (env) => {
  const configured = String(env?.SITE_URL || '').trim();
  try {
    const url = new URL(configured || 'https://nailmania.md');
    if (url.protocol !== 'https:' && !(env?.ENVIRONMENT === 'local' && url.protocol === 'http:')) {
      return new URL('https://nailmania.md');
    }
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return new URL('https://nailmania.md');
  }
};

function orderNotificationCopy(payload) {
  const order = payload.order || {};
  const locale = payload.locale === 'ru' ? 'ru' : 'ro';
  const eventType = ORDER_EMAIL_EVENTS.has(payload.eventType) ? payload.eventType : 'order_created';
  const returned = eventType === 'order_returned'
    ? (order.return || {
      items: Array.isArray(order.items) ? order.items : [],
      refundAmount: Math.max(0, Number(order.total || 0) - Number(order.deliveryFee || 0)),
    })
    : null;
  const items = Array.isArray(returned?.items) ? returned.items : (Array.isArray(order.items) ? order.items : []);
  const eventCopy = orderEventCopy(locale, eventType, order.no);
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
  const summaryRows = returned ? [
    `<tr><td style="padding-top:12px;font-weight:700">${locale === 'ru' ? 'Сумма возврата' : 'Suma returului'}</td><td style="padding-top:12px;text-align:right;font-weight:700;color:#804d20">${escapeHtml(money(returned.refundAmount))} lei</td></tr>`,
  ].join('') : [
    discount > 0 ? `<tr><td style="padding-top:8px;color:#69636a">${locale === 'ru' ? 'Скидка' : 'Reducere'}</td><td style="padding-top:8px;text-align:right">-${escapeHtml(money(discount))} lei</td></tr>` : '',
    deliveryFee > 0 ? `<tr><td style="color:#69636a">${locale === 'ru' ? 'Доставка' : 'Livrare'}</td><td style="text-align:right">${escapeHtml(money(deliveryFee))} lei</td></tr>` : '',
    `<tr><td style="padding-top:12px;font-weight:700">${locale === 'ru' ? 'Итого' : 'Total'}</td><td style="padding-top:12px;text-align:right;font-weight:700;color:#c2557a">${escapeHtml(money(order.total))} lei</td></tr>`,
  ].filter(Boolean).join('');
  const itemHeading = returned
    ? (locale === 'ru' ? 'Возвращённые товары' : 'Produse returnate')
    : (locale === 'ru' ? 'Состав заказа' : 'Produsele comandate');
  const productLabel = locale === 'ru' ? 'Товар' : 'Produs';
  const quantityLabel = locale === 'ru' ? 'Кол-во' : 'Cant.';
  const amountLabel = locale === 'ru' ? 'Сумма' : 'Sumă';
  const address = [order.customer?.city, order.customer?.address].filter(Boolean).join(', ');
  const destinationRows = returned ? '' : `
    <tr><td style="padding:5px 0;color:#69636a">${locale === 'ru' ? 'Доставка' : 'Livrare'}</td><td style="padding:5px 0;text-align:right">${escapeHtml(order.deliveryLabel || '')}</td></tr>
    ${address ? `<tr><td style="padding:5px 0;color:#69636a">${locale === 'ru' ? 'Адрес' : 'Adresa'}</td><td style="padding:5px 0;text-align:right">${escapeHtml(address)}</td></tr>` : ''}
    <tr><td style="padding:5px 0;color:#69636a">${locale === 'ru' ? 'Оплата' : 'Plata'}</td><td style="padding:5px 0;text-align:right">${escapeHtml(order.paymentLabel || '')}</td></tr>`;
  const actionUrl = payload.accountOrderUrl || payload.storeUrl;
  const actionLabel = payload.accountOrderUrl
    ? (locale === 'ru' ? 'Открыть заказ' : 'Vezi comanda')
    : (locale === 'ru' ? 'Перейти в магазин' : 'Mergi la magazin');
  const preheader = `${eventCopy.status} · ${order.no}`;
  const greeting = order.customer?.name
    ? (locale === 'ru' ? `Здравствуйте, ${order.customer.name}!` : `Bună, ${order.customer.name}!`)
    : (locale === 'ru' ? 'Здравствуйте!' : 'Bună!');
  const text = [
    eventCopy.title,
    greeting,
    eventCopy.intro,
    `${locale === 'ru' ? 'Заказ' : 'Comanda'}: ${order.no}`,
    '',
    itemHeading,
    ...itemText,
    '',
    returned
      ? `${locale === 'ru' ? 'Сумма возврата' : 'Suma returului'}: ${money(returned.refundAmount)} lei`
      : [
        discount > 0 ? `${locale === 'ru' ? 'Скидка' : 'Reducere'}: -${money(discount)} lei` : '',
        deliveryFee > 0 ? `${locale === 'ru' ? 'Доставка' : 'Livrare'}: ${money(deliveryFee)} lei` : '',
        `${locale === 'ru' ? 'Итого' : 'Total'}: ${money(order.total)} lei`,
        `${locale === 'ru' ? 'Способ доставки' : 'Metoda de livrare'}: ${order.deliveryLabel || ''}`,
        address ? `${locale === 'ru' ? 'Адрес' : 'Adresa'}: ${address}` : '',
        `${locale === 'ru' ? 'Оплата' : 'Plata'}: ${order.paymentLabel || ''}`,
      ].filter(Boolean).join('\n'),
    '',
    `${actionLabel}: ${actionUrl}`,
  ].filter(Boolean).join('\n');

  return {
    subject: eventCopy.subject,
    text,
    html: `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#fff7f9;color:#272126;font-family:Arial,Helvetica,sans-serif"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#fff7f9"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#ffffff;border:1px solid #f0dce3;border-radius:16px;overflow:hidden"><tr><td align="center" style="padding:24px 28px 18px;border-bottom:1px solid #f3e5e9"><img src="${escapeHtml(payload.logoUrl)}" width="170" alt="Nail Mania" style="display:block;width:170px;max-width:100%;height:auto;border:0"></td></tr><tr><td style="padding:30px 32px 12px"><span style="display:inline-block;padding:7px 12px;border-radius:999px;background:${escapeHtml(eventCopy.color)};color:#ffffff;font-size:12px;font-weight:700">${escapeHtml(eventCopy.status)}</span><h1 style="margin:18px 0 8px;font-size:27px;line-height:1.25;color:#2b2228">${escapeHtml(eventCopy.title)}</h1><p style="margin:0 0 10px;font-size:16px;line-height:1.55">${escapeHtml(greeting)}</p><p style="margin:0;font-size:15px;line-height:1.6;color:#625860">${escapeHtml(eventCopy.intro)}</p><p style="margin:18px 0 0;font-size:13px;color:#7d7078">${locale === 'ru' ? 'Заказ' : 'Comanda'} <b style="color:#2b2228">${safeOrderNo}</b></p></td></tr><tr><td style="padding:18px 32px"><h2 style="margin:0 0 10px;font-size:16px;color:#2b2228">${itemHeading}</h2><table width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse"><thead><tr><th style="padding:9px 0;border-bottom:1px solid #eadde2;text-align:left;font-size:11px;color:#877982;text-transform:uppercase">${productLabel}</th><th style="padding:9px 12px;border-bottom:1px solid #eadde2;text-align:center;font-size:11px;color:#877982;text-transform:uppercase">${quantityLabel}</th><th style="padding:9px 0;border-bottom:1px solid #eadde2;text-align:right;font-size:11px;color:#877982;text-transform:uppercase">${amountLabel}</th></tr></thead><tbody>${itemRows}</tbody></table><table width="100%" cellspacing="0" cellpadding="0" style="width:100%;margin-top:8px;font-size:14px">${summaryRows}</table></td></tr>${destinationRows ? `<tr><td style="padding:2px 32px 18px"><table width="100%" cellspacing="0" cellpadding="0" style="width:100%;padding:14px 16px;background:#fff8fa;border:1px solid #f1dfe5;border-radius:10px;font-size:13px">${destinationRows}</table></td></tr>` : ''}<tr><td align="center" style="padding:8px 32px 32px"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:13px 24px;border-radius:8px;background:#c2557a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700">${actionLabel}</a></td></tr><tr><td align="center" style="padding:18px 24px;background:#2c292b;color:#d8d0d4;font-size:12px;line-height:1.55"><b style="color:#ffffff">Nail Mania</b><br><a href="${escapeHtml(payload.storeUrl)}" style="color:#f1b8c9;text-decoration:none">nailmania.md</a></td></tr></table></td></tr></table></body></html>`,
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
    const replyTo = senderAddress(env?.CUSTOMER_EMAIL_REPLY_TO);
    if (replyTo) body.reply_to = replyTo;
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
  return sendOrderCustomerEmail(env, { ...message, eventType: 'order_created' });
}

export async function sendOrderCustomerEmail(env, message) {
  const eventType = ORDER_EMAIL_EVENTS.has(message.eventType) ? message.eventType : 'order_created';
  const siteUrl = safeSiteUrl(env);
  const order = message.order || {};
  const storeUrl = siteUrl.toString();
  const accountOrderUrl = order.userId && order.id
    ? new URL(`/account/orders/${encodeURIComponent(order.id)}`, siteUrl).toString()
    : '';
  const payload = {
    type: eventType === 'order_created' ? 'order-confirmation' : 'order-notification',
    eventType,
    to: message.email,
    locale: message.locale === 'ru' ? 'ru' : 'ro',
    order,
    storeUrl,
    accountOrderUrl,
    logoUrl: new URL('/images/logo-high.png', siteUrl).toString(),
  };
  await sendCustomerEmail(env, payload, orderNotificationCopy(payload), {
    idempotencyKey: message.idempotencyKey,
  });
}
