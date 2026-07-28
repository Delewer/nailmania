import {
  CustomerAuthError,
  newSessionRecord,
  normalizeEmail,
  publicUser,
  requireCustomerMutation,
  sessionCookie,
  verifyPassword,
} from '../../_lib/customer-auth.js';
import { customerApiError, readCustomerJson, turnstileToken } from '../../_lib/customer-http.js';
import { json, requireDatabase } from '../../_lib/http.js';
import { verifyTurnstile } from '../../_lib/turnstile.js';

const invalidCredentials = () => new CustomerAuthError(
  'INVALID_CREDENTIALS',
  'Email or password is incorrect',
  401,
);

export async function onRequestPost(context) {
  try {
    requireCustomerMutation(context.request, context.env);
    const body = await readCustomerJson(context.request);
    await verifyTurnstile({
      request: context.request,
      env: context.env,
      token: turnstileToken(body),
      action: 'login',
    });
    let email = '';
    try { email = normalizeEmail(body.email); }
    catch { /* Keep all credential failures indistinguishable. */ }
    const binding = requireDatabase(context.env);
    const db = typeof binding.withSession === 'function' ? binding.withSession('first-primary') : binding;
    const row = email ? await db.prepare(`
      SELECT id, email, phone, name, role, status, password_hash, email_verified_at
      FROM users WHERE email = ? COLLATE NOCASE LIMIT 1
    `).bind(email).first() : null;
    const passwordMatches = await verifyPassword(body.password, row?.password_hash);
    if (!row || row.status !== 'active' || !passwordMatches) throw invalidCredentials();

    const session = await newSessionRecord(db, row.id, context.request, context.env);
    const now = new Date().toISOString();
    await db.batch([
      db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?')
        .bind(now, now, row.id),
      session.statement,
    ]);
    return json({ ok: true, user: publicUser(row) }, 200, {
      'cache-control': 'no-store',
      'set-cookie': sessionCookie(context.request, context.env, session.token),
    });
  } catch (error) {
    return customerApiError(error);
  }
}
