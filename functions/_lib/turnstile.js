const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export class HumanVerificationError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'HumanVerificationError';
    this.code = code;
    this.status = status;
  }
}

function configuredHostnames(env) {
  return String(env?.TURNSTILE_HOSTNAMES || '')
    .split(',')
    .map((hostname) => hostname.trim().toLowerCase())
    .filter(Boolean);
}

export async function verifyTurnstile({ request, env, token, action }) {
  const secret = String(env?.TURNSTILE_SECRET_KEY || '').trim();
  if (!secret) {
    if (env?.ENVIRONMENT === 'local') return { success: true, bypassed: true };
    throw new HumanVerificationError(
      'HUMAN_VERIFICATION_NOT_CONFIGURED',
      'Human verification is temporarily unavailable',
      503,
    );
  }
  if (!String(token || '').trim()) {
    throw new HumanVerificationError('HUMAN_VERIFICATION_REQUIRED', 'Please complete the verification', 400);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let result;
  try {
    const fetcher = env?.TURNSTILE_FETCH || fetch;
    const response = await fetcher(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secret,
        response: String(token).trim(),
        remoteip: request.headers.get('cf-connecting-ip') || undefined,
        idempotency_key: crypto.randomUUID(),
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Siteverify returned HTTP ${response.status}`);
    result = await response.json();
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'turnstile.unavailable',
      message: String(error?.message || error),
    }));
    throw new HumanVerificationError(
      'HUMAN_VERIFICATION_UNAVAILABLE',
      'Human verification is temporarily unavailable',
      503,
    );
  } finally {
    clearTimeout(timeout);
  }

  const configured = configuredHostnames(env);
  const requestHostname = new URL(request.url).hostname.toLowerCase();
  const allowedHostnames = configured.length ? configured : [requestHostname];
  const hostname = String(result?.hostname || '').toLowerCase();
  const actionMatches = !action || result?.action === action;
  const hostnameMatches = Boolean(hostname) && allowedHostnames.includes(hostname);
  if (!result?.success || !actionMatches || !hostnameMatches) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'turnstile.rejected',
      action,
      responseAction: result?.action || '',
      hostname,
      errorCodes: Array.isArray(result?.['error-codes']) ? result['error-codes'] : [],
    }));
    throw new HumanVerificationError('HUMAN_VERIFICATION_FAILED', 'Verification failed; please try again', 403);
  }
  return result;
}

export { SITEVERIFY_URL };
