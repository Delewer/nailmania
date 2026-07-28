import { normalizeProfile, requireCustomerMutation, resolveCustomer } from '../../_lib/customer-auth.js';
import { customerApiError, readCustomerJson } from '../../_lib/customer-http.js';
import { json } from '../../_lib/http.js';

export async function onRequestGet(context) {
  try {
    const auth = await resolveCustomer(context, { required: true });
    return json({ ok: true, user: auth.user }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return customerApiError(error);
  }
}

export async function onRequestPatch(context) {
  try {
    requireCustomerMutation(context.request, context.env);
    const auth = await resolveCustomer(context, { required: true });
    const body = await readCustomerJson(context.request);
    const profile = normalizeProfile({
      name: Object.hasOwn(body, 'name') ? body.name : auth.user.name,
      phone: Object.hasOwn(body, 'phone') ? body.phone : auth.user.phone,
    });
    const now = new Date().toISOString();
    await auth.db.prepare(`
      UPDATE users SET name = ?, phone = ?, updated_at = ?
      WHERE id = ? AND status = 'active'
    `).bind(profile.name, profile.phone, now, auth.user.id).run();
    return json({
      ok: true,
      user: { ...auth.user, name: profile.name, phone: profile.phone },
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return customerApiError(error);
  }
}
