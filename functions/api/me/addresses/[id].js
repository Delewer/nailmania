import { CustomerAuthError, requireCustomerMutation, resolveCustomer } from '../../../_lib/customer-auth.js';
import { normalizeAddress, publicAddress } from '../../../_lib/customer-account.js';
import { customerApiError, readCustomerJson } from '../../../_lib/customer-http.js';
import { json } from '../../../_lib/http.js';

const addressId = (params) => {
  try { return decodeURIComponent(String(params?.id || '')).trim().slice(0, 120); }
  catch { throw new CustomerAuthError('INVALID_ADDRESS_ID', 'Address id is invalid'); }
};

const ownedAddress = async (db, userId, id) => {
  const row = await db.prepare('SELECT * FROM user_addresses WHERE id = ? AND user_id = ?')
    .bind(id, userId).first();
  if (!row) throw new CustomerAuthError('ADDRESS_NOT_FOUND', 'Address not found', 404);
  return row;
};

export async function onRequestPatch(context) {
  try {
    requireCustomerMutation(context.request, context.env);
    const auth = await resolveCustomer(context, { required: true });
    const id = addressId(context.params);
    if (!id) throw new CustomerAuthError('INVALID_ADDRESS_ID', 'Address id is required');
    const existing = await ownedAddress(auth.db, auth.user.id, id);
    const body = await readCustomerJson(context.request);
    const address = normalizeAddress(body, existing);
    if (existing.is_default && !address.isDefault) address.isDefault = true;
    const now = new Date().toISOString();
    const statements = [];
    if (address.isDefault) {
      statements.push(auth.db.prepare(`
        UPDATE user_addresses SET is_default = 0, updated_at = ?
        WHERE user_id = ? AND is_default = 1 AND id <> ?
      `).bind(now, auth.user.id, id));
    }
    statements.push(auth.db.prepare(`
      UPDATE user_addresses
      SET recipient_name = ?, phone = ?, city = ?, address = ?, comment = ?,
          is_default = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).bind(
      address.recipientName, address.phone, address.city, address.address,
      address.comment, address.isDefault ? 1 : 0, now, id, auth.user.id,
    ));
    await auth.db.batch(statements);
    const row = await ownedAddress(auth.db, auth.user.id, id);
    return json({ ok: true, address: publicAddress(row) }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return customerApiError(error);
  }
}

export async function onRequestDelete(context) {
  try {
    requireCustomerMutation(context.request, context.env);
    const auth = await resolveCustomer(context, { required: true });
    const id = addressId(context.params);
    if (!id) throw new CustomerAuthError('INVALID_ADDRESS_ID', 'Address id is required');
    await ownedAddress(auth.db, auth.user.id, id);
    const now = new Date().toISOString();
    await auth.db.batch([
      auth.db.prepare('DELETE FROM user_addresses WHERE id = ? AND user_id = ?')
        .bind(id, auth.user.id),
      auth.db.prepare(`
        UPDATE user_addresses SET is_default = 1, updated_at = ?
        WHERE id = (
          SELECT id FROM user_addresses
          WHERE user_id = ?
          ORDER BY updated_at DESC, id
          LIMIT 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM user_addresses WHERE user_id = ? AND is_default = 1
        )
      `).bind(now, auth.user.id, auth.user.id),
    ]);
    return json({ ok: true }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return customerApiError(error);
  }
}
