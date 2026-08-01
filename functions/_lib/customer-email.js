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

const customSender = (env) => {
  if (typeof env?.CUSTOMER_EMAIL_SEND === 'function') return env.CUSTOMER_EMAIL_SEND;
  if (typeof env?.CUSTOMER_EMAIL_SERVICE?.sendPasswordReset === 'function') {
    return (message) => env.CUSTOMER_EMAIL_SERVICE.sendPasswordReset(message);
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
  if (customSender(env) || serviceFetcher(env)) return true;
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

export async function sendPasswordResetEmail(env, message) {
  const payload = {
    type: 'password-reset',
    to: message.email,
    locale: message.locale === 'ru' ? 'ru' : 'ro',
    resetUrl: message.resetUrl,
    expiresAt: message.expiresAt,
  };
  const sender = customSender(env);
  if (sender) {
    await checkedSender(sender, payload);
    return;
  }

  const service = serviceFetcher(env);
  if (service) {
    await checkedFetch((request, init) => service.fetch(request, init), new Request(
      'https://customer-email.internal/password-reset',
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
    const copy = passwordResetCopy(payload);
    headers.accept = 'application/json';
    headers['user-agent'] = 'nailmania-password-reset/1.0';
    body = {
      from: resend.from,
      to: [payload.to],
      subject: copy.subject,
      text: copy.text,
      html: copy.html,
    };
    if (message.idempotencyKey) {
      headers['idempotency-key'] = String(message.idempotencyKey).slice(0, 256);
    }
  }
  const fetcher = env?.CUSTOMER_EMAIL_FETCH || fetch;
  await checkedFetch((request, init) => fetcher(request, init), new Request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }));
}
