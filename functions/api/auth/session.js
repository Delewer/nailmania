import { resolveCustomer } from '../../_lib/customer-auth.js';
import { customerApiError } from '../../_lib/customer-http.js';
import { json } from '../../_lib/http.js';

export async function onRequestGet(context) {
  try {
    const auth = await resolveCustomer(context);
    return json({
      ok: true,
      authenticated: Boolean(auth),
      user: auth?.user || null,
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return customerApiError(error);
  }
}
