const DELIVERY_TIMEOUT_MS = 8_000;

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
  const hasDelivery = Boolean(
    customSender(env)
      || serviceFetcher(env)
      || String(env?.CUSTOMER_EMAIL_ENDPOINT || '').trim(),
  );
  if (!hasDelivery) throw new CustomerEmailError();
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

  const endpoint = String(env?.CUSTOMER_EMAIL_ENDPOINT || '').trim();
  if (!endpoint) throw new CustomerEmailError();
  let endpointUrl;
  try { endpointUrl = new URL(endpoint); }
  catch { throw new CustomerEmailError(); }
  if (env?.ENVIRONMENT !== 'local' && endpointUrl.protocol !== 'https:') throw new CustomerEmailError();
  const headers = { 'content-type': 'application/json' };
  const apiToken = String(env?.CUSTOMER_EMAIL_API_TOKEN || '').trim();
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  const fetcher = env?.CUSTOMER_EMAIL_FETCH || fetch;
  await checkedFetch((request, init) => fetcher(request, init), new Request(endpointUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  }));
}
