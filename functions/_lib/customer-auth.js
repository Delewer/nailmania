import { requireDatabase, requireJsonContentType } from './http.js';

const encoder = new TextEncoder();
const SESSION_COOKIE = 'nm_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_ITERATIONS = 600_000;
const PASSWORD_ALGORITHM = 'PBKDF2';
const PASSWORD_FORMAT = 'pbkdf2-sha256';
const DUMMY_PASSWORD_HASH = `${PASSWORD_FORMAT}$${PASSWORD_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

export class CustomerAuthError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'CustomerAuthError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const bytesToBase64Url = (bytes) => btoa(String.fromCharCode(...bytes))
  .replaceAll('+', '-')
  .replaceAll('/', '_')
  .replace(/=+$/g, '');

const base64UrlToBytes = (value) => {
  const normalized = String(value).replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const randomToken = (length = 32) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
};

const digestHex = async (value) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))]
  .map((byte) => byte.toString(16).padStart(2, '0'))
  .join('');

async function derivePassword(password, salt, iterations = PASSWORD_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    PASSWORD_ALGORITHM,
    false,
    ['deriveBits'],
  );
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: PASSWORD_ALGORITHM,
    hash: 'SHA-256',
    salt,
    iterations,
  }, material, 256));
}

function constantTimeEqual(left, right) {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] || 0) ^ (right[index] || 0);
  }
  return difference === 0;
}

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CustomerAuthError('INVALID_EMAIL', 'Enter a valid email address', 400);
  }
  return email;
}

export function normalizePassword(value) {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 10 || password.length > 128) {
    throw new CustomerAuthError('INVALID_PASSWORD', 'Password must contain between 10 and 128 characters', 400);
  }
  return password;
}

export function normalizeProfile(input, { requireName = true } = {}) {
  const name = String(input?.name || '').trim().replace(/\s+/g, ' ');
  const phone = String(input?.phone || '').trim().replace(/\s+/g, ' ');
  if (requireName && (name.length < 2 || name.length > 100)) {
    throw new CustomerAuthError('INVALID_NAME', 'Name must contain between 2 and 100 characters', 400);
  }
  if (phone.length > 30) throw new CustomerAuthError('INVALID_PHONE', 'Phone number is too long', 400);
  return { name, phone };
}

export async function hashPassword(value) {
  const password = normalizePassword(value);
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await derivePassword(password, salt);
  return `${PASSWORD_FORMAT}$${PASSWORD_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

export async function verifyPassword(value, encodedHash) {
  const password = typeof value === 'string' && value.length <= 128 ? value : '';
  const parts = String(encodedHash || DUMMY_PASSWORD_HASH).split('$');
  if (parts.length !== 4 || parts[0] !== PASSWORD_FORMAT) {
    await derivePassword(password, new Uint8Array(16));
    return false;
  }
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) {
    await derivePassword(password, new Uint8Array(16));
    return false;
  }
  try {
    const salt = base64UrlToBytes(parts[2]);
    const expected = base64UrlToBytes(parts[3]);
    const actual = await derivePassword(password, salt, iterations);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

function cookieValue(request, name) {
  const cookies = String(request.headers.get('cookie') || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) return cookie.slice(separator + 1).trim();
  }
  return '';
}

function shouldSecureCookie(request, env) {
  return env?.ENVIRONMENT !== 'local' || new URL(request.url).protocol === 'https:';
}

export function sessionCookie(request, env, token, maxAge = SESSION_MAX_AGE_SECONDS) {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(shouldSecureCookie(request, env) ? ['Secure'] : []),
  ].join('; ');
}

export const clearSessionCookie = (request, env) => sessionCookie(request, env, '', 0);

const requestFingerprintHash = async (request, env) => {
  const salt = String(env?.AUTH_FINGERPRINT_SALT || (env?.ENVIRONMENT === 'local' ? 'local-development-only' : ''));
  if (!salt) {
    throw new CustomerAuthError('AUTH_NOT_CONFIGURED', 'Customer authentication is temporarily unavailable', 503);
  }
  const ip = request.headers.get('cf-connecting-ip') || '';
  return digestHex(`${salt}\0${ip}`);
};

export async function newSessionRecord(db, userId, request, env, now = new Date()) {
  const token = randomToken();
  const tokenHash = await digestHex(token);
  const id = crypto.randomUUID();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  const ipHash = await requestFingerprintHash(request, env);
  const userAgent = String(request.headers.get('user-agent') || '').slice(0, 300);
  const statement = db.prepare(`
    INSERT INTO sessions (
      id, user_id, token_hash, expires_at, last_used_at, created_at, ip_hash, user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, userId, tokenHash, expiresAt, createdAt, createdAt, ipHash, userAgent);
  return { id, token, tokenHash, expiresAt, statement };
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone || '',
    name: row.name || '',
    role: row.role,
    emailVerified: Boolean(row.email_verified_at),
  };
}

export async function resolveCustomer(context, { required = false } = {}) {
  const token = cookieValue(context.request, SESSION_COOKIE);
  if (!token || token.length > 128) {
    if (required) throw new CustomerAuthError('AUTH_REQUIRED', 'Sign in to continue', 401);
    return null;
  }
  const dbBinding = requireDatabase(context.env);
  const db = typeof dbBinding.withSession === 'function' ? dbBinding.withSession('first-primary') : dbBinding;
  const tokenHash = await digestHex(token);
  const now = new Date();
  const row = await db.prepare(`
    SELECT s.id AS session_id, s.last_used_at, s.expires_at,
           u.id, u.email, u.phone, u.name, u.role, u.status, u.email_verified_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
  `).bind(tokenHash, now.toISOString()).first();
  if (!row || row.status !== 'active') {
    if (required) throw new CustomerAuthError('AUTH_REQUIRED', 'Session is invalid or expired', 401);
    return null;
  }

  const lastUsed = Date.parse(row.last_used_at || '');
  if (!Number.isFinite(lastUsed) || now.getTime() - lastUsed > 15 * 60 * 1000) {
    const touch = db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL')
      .bind(now.toISOString(), row.session_id).run();
    if (typeof context.waitUntil === 'function') context.waitUntil(Promise.resolve(touch));
    else await touch;
  }
  return { db, sessionId: row.session_id, user: publicUser(row) };
}

export function requireCustomerMutation(request, env) {
  const origin = request.headers.get('origin');
  const fetchSite = String(request.headers.get('sec-fetch-site') || '').toLowerCase();
  let sameOrigin = false;
  try { sameOrigin = Boolean(origin) && new URL(origin).origin === new URL(request.url).origin; }
  catch { sameOrigin = false; }
  if ((!origin && env?.ENVIRONMENT !== 'local') || (origin && !sameOrigin) || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
    throw new CustomerAuthError('CROSS_ORIGIN_REQUEST', 'Cross-origin account requests are not allowed', 403);
  }
  requireJsonContentType(request);
}

export async function revokeSession(db, sessionId, now = new Date()) {
  if (!sessionId) return;
  await db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(now.toISOString(), sessionId).run();
}

export {
  DUMMY_PASSWORD_HASH,
  PASSWORD_ITERATIONS,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  digestHex,
  publicUser,
  randomToken,
  requestFingerprintHash,
};
