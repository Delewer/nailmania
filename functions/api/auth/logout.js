import {
  clearSessionCookie,
  requireCustomerMutation,
  resolveCustomer,
  revokeSession,
} from '../../_lib/customer-auth.js';
import { customerApiError } from '../../_lib/customer-http.js';
import { json } from '../../_lib/http.js';

export async function onRequestPost(context) {
  try {
    requireCustomerMutation(context.request, context.env);
    const auth = await resolveCustomer(context);
    if (auth) await revokeSession(auth.db, auth.sessionId);
    return json({ ok: true }, 200, {
      'cache-control': 'no-store',
      'set-cookie': clearSessionCookie(context.request, context.env),
    });
  } catch (error) {
    return customerApiError(error);
  }
}
