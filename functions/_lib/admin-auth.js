import { createRemoteJWKSet, jwtVerify } from 'jose';
import { requireDatabase } from './http.js';

const jwksCache = new Map();

export class AdminAuthError extends Error {
  constructor(code, message, status = 401) {
    super(message);
    this.name = 'AdminAuthError';
    this.code = code;
    this.status = status;
  }
}

const normalizeDomain = (value) => {
  const raw = String(value || '').trim().replace(/\/$/, '');
  if (!raw) return '';
  return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin;
};

async function sameSecret(actual, expected) {
  if (!actual || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) difference |= (a[i] || 0) ^ (b[i] || 0);
  return difference === 0;
}

async function accessEmail(request, env) {
  if (env?.ENVIRONMENT === 'local') {
    const configuredToken = String(env.ADMIN_DEV_TOKEN || '');
    if (!configuredToken) throw new AdminAuthError('ADMIN_AUTH_NOT_CONFIGURED', 'Local admin token is not configured', 503);
    const authorization = String(request.headers.get('authorization') || '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!(await sameSecret(token, configuredToken))) {
      throw new AdminAuthError('ADMIN_AUTH_REQUIRED', 'Local administrator authentication is required', 401);
    }
    return { email: String(env.ADMIN_DEV_EMAIL || 'admin@nailmania.local').toLowerCase(), source: 'local' };
  }

  const domain = normalizeDomain(env?.CF_ACCESS_TEAM_DOMAIN);
  const audience = String(env?.CF_ACCESS_AUD || '').trim();
  if (!domain || !audience) {
    throw new AdminAuthError('ADMIN_AUTH_NOT_CONFIGURED', 'Cloudflare Access is not configured', 503);
  }
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) throw new AdminAuthError('ADMIN_AUTH_REQUIRED', 'Cloudflare Access authentication is required', 401);

  try {
    let jwks = jwksCache.get(domain);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${domain}/cdn-cgi/access/certs`));
      jwksCache.set(domain, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, { issuer: domain, audience });
    const email = String(payload.email || '').trim().toLowerCase();
    if (!email) throw new Error('Access token has no email claim');
    return { email, source: 'cloudflare-access' };
  } catch {
    throw new AdminAuthError('ADMIN_AUTH_INVALID', 'Cloudflare Access token is invalid or expired', 401);
  }
}

export async function requireAdmin(context, roles = ['manager', 'admin']) {
  const db = requireDatabase(context.env);
  const identity = await accessEmail(context.request, context.env);
  const database = typeof db.withSession === 'function' ? db.withSession('first-primary') : db;
  const user = await database.prepare(`
    SELECT id, email, phone, name, role, status, last_login_at
    FROM users WHERE email = ? COLLATE NOCASE
  `).bind(identity.email).first();
  if (!user || user.status !== 'active' || !roles.includes(user.role)) {
    throw new AdminAuthError('ADMIN_FORBIDDEN', 'This account does not have administrative access', 403);
  }
  return { db: database, identity, user };
}

export function requireSameOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) {
    if (env?.ENVIRONMENT === 'local') return;
    throw new AdminAuthError('CROSS_ORIGIN_REQUEST', 'Administrative mutations require a same-origin request', 403);
  }
  const fetchSite = String(request.headers.get('sec-fetch-site') || '').toLowerCase();
  let valid = false;
  try { valid = new URL(origin).origin === new URL(request.url).origin; }
  catch { valid = false; }
  if (!valid || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
    throw new AdminAuthError('CROSS_ORIGIN_REQUEST', 'Cross-origin administrative requests are not allowed', 403);
  }
}
