const encoder = new TextEncoder();

export class RateLimitError extends Error {
  constructor(code, message, status = 429, retryAfter = 0) {
    super(message);
    this.name = 'RateLimitError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function rateLimitSecret(env) {
  const secret = String(env?.RATE_LIMIT_SECRET || '').trim();
  if (secret.length >= 16) return secret;
  if (env?.ENVIRONMENT === 'local') return 'local-rate-limit-secret';
  throw new RateLimitError(
    'RATE_LIMIT_NOT_CONFIGURED',
    'Request protection is temporarily unavailable',
    503,
  );
}

export async function enforceRateLimit({
  db,
  request,
  env,
  scope,
  limit,
  windowSeconds,
  now = new Date(),
  identity,
}) {
  if (!db) {
    if (env?.ENVIRONMENT === 'local') return { bypassed: true };
    throw new RateLimitError('RATE_LIMIT_NOT_CONFIGURED', 'Request protection is temporarily unavailable', 503);
  }
  const secret = rateLimitSecret(env);
  const keyIdentity = String(identity || request.headers.get('cf-connecting-ip') || 'unknown').slice(0, 300);
  const keyHash = await hmacHex(secret, `${scope}\0${keyIdentity}`);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const expiresAt = windowStart + windowSeconds * 2;
  const database = typeof db.withSession === 'function' ? db.withSession('first-primary') : db;
  const row = await database.prepare(`
    INSERT INTO rate_limit_buckets (scope, key_hash, window_start, hits, expires_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(scope, key_hash, window_start) DO UPDATE SET
      hits = rate_limit_buckets.hits + 1,
      expires_at = excluded.expires_at
    RETURNING hits
  `).bind(scope, keyHash, windowStart, expiresAt).first();
  const hits = Number(row?.hits || 0);
  const retryAfter = Math.max(1, windowStart + windowSeconds - nowSeconds);
  if (hits > limit) {
    throw new RateLimitError('RATE_LIMITED', 'Too many requests; please try again later', 429, retryAfter);
  }
  return { scope, hits, limit, retryAfter, windowStart };
}

export async function cleanupExpiredRateLimits(db, { now = new Date() } = {}) {
  if (!db) throw new Error('D1 binding DB is not configured');
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const result = await db.prepare(`
    DELETE FROM rate_limit_buckets
    WHERE expires_at <= ?
  `).bind(nowSeconds).run();
  return { deleted: Number(result?.meta?.changes || 0) };
}

export const RATE_LIMIT_RULES = [
  { method: 'POST', pathname: '/api/orders', scope: 'orders.create', limit: 12, windowSeconds: 10 * 60 },
  { method: 'POST', pathname: '/api/auth/register', scope: 'auth.register', limit: 5, windowSeconds: 60 * 60 },
  { method: 'POST', pathname: '/api/auth/login', scope: 'auth.login', limit: 10, windowSeconds: 10 * 60 },
  { method: 'POST', pathname: '/api/auth/forgot-password', scope: 'auth.forgot', limit: 5, windowSeconds: 60 * 60 },
  { method: 'POST', pathname: '/api/auth/reset-password', scope: 'auth.reset', limit: 10, windowSeconds: 60 * 60 },
  { method: 'POST', pathname: '/api/promos/validate', scope: 'promos.validate', limit: 30, windowSeconds: 10 * 60 },
  { method: 'POST', pathname: '/api/events', scope: 'analytics.events', limit: 120, windowSeconds: 10 * 60 },
  { method: 'POST', pathname: '/api/admin/uploads', scope: 'admin.upload', limit: 30, windowSeconds: 60 * 60 },
  {
    method: 'POST',
    pattern: /^\/api\/admin\/orders\/[^/]+\/notifications\/telegram$/,
    scope: 'admin.telegram_resend',
    limit: 10,
    windowSeconds: 60 * 60,
  },
];

export function rateLimitRule(request) {
  const pathname = new URL(request.url).pathname.replace(/\/$/, '') || '/';
  return RATE_LIMIT_RULES.find((rule) => rule.method === request.method
    && (rule.pathname === pathname || rule.pattern?.test(pathname))) || null;
}
