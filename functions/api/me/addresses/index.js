import { CustomerAuthError, requireCustomerMutation, resolveCustomer } from '../../../_lib/customer-auth.js';
import { normalizeAddress, publicAddress } from '../../../_lib/customer-account.js';
import { customerApiError, readCustomerJson } from '../../../_lib/customer-http.js';
import { json } from '../../../_lib/http.js';

const MAX_ADDRESSES = 20;

export async function onRequestGet(context) {
  try {
    const auth = await resolveCustomer(context, { required: true });
    const result = await auth.db.prepare(`
      SELECT * FROM user_addresses
      WHERE user_id = ?
      ORDER BY is_default DESC, updated_at DESC, id
    `).bind(auth.user.id).all();
    return json({ ok: true, items: (result.results || []).map(publicAddress) }, 200, {
      'cache-control': 'no-store',
    });
  } catch (error) {
    return customerApiError(error);
  }
}

export async function onRequestPost(context) {
  try {
    requireCustomerMutation(context.request, context.env);
    const auth = await resolveCustomer(context, { required: true });
    const body = await readCustomerJson(context.request);
    const address = normalizeAddress(body);
    const count = await auth.db.prepare(`
      SELECT COUNT(*) AS count FROM user_addresses WHERE user_id = ?
    `).bind(auth.user.id).first();
    if (Number(count?.count || 0) >= MAX_ADDRESSES) {
      throw new CustomerAuthError('ADDRESS_LIMIT_REACHED', `A maximum of ${MAX_ADDRESSES} addresses is allowed`, 409);
    }
    const makeDefault = address.isDefault || Number(count?.count || 0) === 0;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const statements = [];
    if (makeDefault) {
      statements.push(auth.db.prepare(`
        UPDATE user_addresses SET is_default = 0, updated_at = ?
        WHERE user_id = ? AND is_default = 1
      `).bind(now, auth.user.id));
    }
    statements.push(auth.db.prepare(`
      INSERT INTO user_addresses (
        id, user_id, recipient_name, phone, city, address, comment,
        is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, auth.user.id, address.recipientName, address.phone, address.city,
      address.address, address.comment, makeDefault ? 1 : 0, now, now,
    ));
    await auth.db.batch(statements);
    const row = await auth.db.prepare('SELECT * FROM user_addresses WHERE id = ? AND user_id = ?')
      .bind(id, auth.user.id).first();
    return json({ ok: true, address: publicAddress(row) }, 201, { 'cache-control': 'no-store' });
  } catch (error) {
    return customerApiError(error);
  }
}
