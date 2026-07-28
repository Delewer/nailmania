import {
  digestHex,
  normalizeEmail,
  randomToken,
  requireCustomerMutation,
  requestFingerprintHash,
} from '../../_lib/customer-auth.js';
import { customerApiError, readCustomerJson, turnstileToken } from '../../_lib/customer-http.js';
import { json, requireDatabase } from '../../_lib/http.js';
import { deliverPasswordResetNotification } from '../../_lib/notifications.js';
import { verifyTurnstile } from '../../_lib/turnstile.js';

const accepted = () => json({
  ok: true,
  message: 'If an active account exists, password reset instructions will be sent.',
}, 202, { 'cache-control': 'no-store' });

export async function onRequestPost(context) {
  try {
    requireCustomerMutation(context.request, context.env);
    const body = await readCustomerJson(context.request);
    await verifyTurnstile({
      request: context.request,
      env: context.env,
      token: turnstileToken(body),
      action: 'forgot_password',
    });
    let email = '';
    try { email = normalizeEmail(body.email); }
    catch { return accepted(); }

    const binding = requireDatabase(context.env);
    const db = typeof binding.withSession === 'function' ? binding.withSession('first-primary') : binding;
    const user = await db.prepare(`
      SELECT id, email FROM users
      WHERE email = ? COLLATE NOCASE AND status = 'active'
      LIMIT 1
    `).bind(email).first();
    if (!user) return accepted();

    const token = randomToken();
    const tokenHash = await digestHex(token);
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const requestedIpHash = await requestFingerprintHash(context.request, context.env);
    const tokenId = crypto.randomUUID();
    await db.batch([
      db.prepare(`
        UPDATE password_reset_tokens SET used_at = ?
        WHERE user_id = ? AND used_at IS NULL
      `).bind(createdAt, user.id),
      db.prepare(`
        INSERT INTO password_reset_tokens (
          id, user_id, token_hash, expires_at, requested_ip_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).bind(tokenId, user.id, tokenHash, expiresAt, requestedIpHash, createdAt),
    ]);

    let delivered = false;
    try {
      const notification = await deliverPasswordResetNotification({
        db,
        env: context.env,
        request: context.request,
        tokenId,
        token,
        email: user.email,
        locale: body.locale ?? body.lang,
        expiresAt,
        requestId: context.data?.requestId || '',
      });
      delivered = notification.delivered;
    } catch {
      console.error(JSON.stringify({
        level: 'error',
        event: 'notification.email.persistence_failed',
        requestId: String(context.data?.requestId || '').slice(0, 100),
        channel: 'email',
        eventType: 'password_reset',
        code: 'NOTIFICATION_PERSISTENCE_FAILED',
      }));
    }
    if (!delivered) {
      await db.prepare(`
        UPDATE password_reset_tokens SET used_at = ?
        WHERE id = ? AND used_at IS NULL
      `).bind(new Date().toISOString(), tokenId).run();
    }
    return accepted();
  } catch (error) {
    return customerApiError(error);
  }
}
