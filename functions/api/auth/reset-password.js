import {
  clearSessionCookie,
  CustomerAuthError,
  digestHex,
  hashPassword,
  requireCustomerMutation,
} from '../../_lib/customer-auth.js';
import { customerApiError, readCustomerJson, turnstileToken } from '../../_lib/customer-http.js';
import { json, requireDatabase } from '../../_lib/http.js';
import { verifyTurnstile } from '../../_lib/turnstile.js';

const invalidReset = () => new CustomerAuthError(
  'INVALID_RESET_TOKEN',
  'Password reset link is invalid or expired',
  400,
);

const changedRows = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

export async function onRequestPost(context) {
  try {
    requireCustomerMutation(context.request, context.env);
    const body = await readCustomerJson(context.request);
    await verifyTurnstile({
      request: context.request,
      env: context.env,
      token: turnstileToken(body),
      action: 'reset_password',
    });
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const wellFormed = /^[A-Za-z0-9_-]{32,128}$/.test(token);
    const tokenHash = await digestHex(wellFormed ? token : 'invalid-password-reset-token');
    const binding = requireDatabase(context.env);
    const db = typeof binding.withSession === 'function' ? binding.withSession('first-primary') : binding;
    const now = new Date().toISOString();
    const reset = await db.prepare(`
      SELECT t.user_id
      FROM password_reset_tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ?
        AND u.status = 'active'
      LIMIT 1
    `).bind(tokenHash, now).first();
    if (!wellFormed || !reset) throw invalidReset();

    const passwordHash = await hashPassword(body.password);
    const results = await db.batch([
      db.prepare(`
        UPDATE users
        SET password_hash = ?, password_changed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active'
          AND EXISTS (
            SELECT 1 FROM password_reset_tokens
            WHERE token_hash = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?
          )
      `).bind(passwordHash, now, now, reset.user_id, tokenHash, reset.user_id, now),
      db.prepare(`
        UPDATE sessions SET revoked_at = ?
        WHERE user_id = ? AND revoked_at IS NULL
          AND EXISTS (
            SELECT 1 FROM users
            WHERE id = ? AND password_hash = ? AND password_changed_at = ?
          )
      `).bind(now, reset.user_id, reset.user_id, passwordHash, now),
      db.prepare(`
        UPDATE password_reset_tokens SET used_at = ?
        WHERE user_id = ? AND used_at IS NULL
          AND EXISTS (
            SELECT 1 FROM users
            WHERE id = ? AND password_hash = ? AND password_changed_at = ?
          )
      `).bind(now, reset.user_id, reset.user_id, passwordHash, now),
    ]);
    if (changedRows(results?.[0]) !== 1) throw invalidReset();
    return json({ ok: true }, 200, {
      'cache-control': 'no-store',
      'set-cookie': clearSessionCookie(context.request, context.env),
    });
  } catch (error) {
    return customerApiError(error);
  }
}
