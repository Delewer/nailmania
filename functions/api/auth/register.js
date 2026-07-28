import {
  CustomerAuthError,
  hashPassword,
  newSessionRecord,
  normalizeEmail,
  normalizeProfile,
  publicUser,
  requireCustomerMutation,
  sessionCookie,
} from '../../_lib/customer-auth.js';
import { customerApiError, readCustomerJson, turnstileToken } from '../../_lib/customer-http.js';
import { json, requireDatabase } from '../../_lib/http.js';
import { verifyTurnstile } from '../../_lib/turnstile.js';

export async function onRequestPost(context) {
  try {
    requireCustomerMutation(context.request, context.env);
    const body = await readCustomerJson(context.request);
    await verifyTurnstile({
      request: context.request,
      env: context.env,
      token: turnstileToken(body),
      action: 'register',
    });
    const email = normalizeEmail(body.email);
    const profile = normalizeProfile({
      name: body.name ?? body.profile?.name,
      phone: body.phone ?? body.profile?.phone,
    });
    const passwordHash = await hashPassword(body.password);
    const binding = requireDatabase(context.env);
    const db = typeof binding.withSession === 'function' ? binding.withSession('first-primary') : binding;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const session = await newSessionRecord(db, id, context.request, context.env);
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO users (
            id, email, phone, name, role, status, password_hash,
            created_at, updated_at, password_changed_at
          ) VALUES (?, ?, ?, ?, 'customer', 'active', ?, ?, ?, ?)
        `).bind(id, email, profile.phone, profile.name, passwordHash, now, now, now),
        session.statement,
      ]);
    } catch (error) {
      if (/UNIQUE constraint failed:\s*users\.email|users_email|SQLITE_CONSTRAINT_UNIQUE/i.test(String(error?.message || error))) {
        throw new CustomerAuthError('ACCOUNT_ALREADY_EXISTS', 'An account with this email already exists', 409);
      }
      throw error;
    }
    const user = publicUser({
      id, email, phone: profile.phone, name: profile.name, role: 'customer', email_verified_at: null,
    });
    return json({ ok: true, user }, 201, {
      'cache-control': 'no-store',
      'set-cookie': sessionCookie(context.request, context.env, session.token),
    });
  } catch (error) {
    return customerApiError(error);
  }
}
