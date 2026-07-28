import { CustomerAuthError, resolveCustomer } from '../../../_lib/customer-auth.js';
import { getCustomerOrder } from '../../../_lib/customer-account.js';
import { customerApiError } from '../../../_lib/customer-http.js';
import { json } from '../../../_lib/http.js';

const orderId = (params) => {
  try { return decodeURIComponent(String(params?.id || '')).trim().slice(0, 120); }
  catch { throw new CustomerAuthError('INVALID_ORDER_ID', 'Order id is invalid'); }
};

export async function onRequestGet(context) {
  try {
    const auth = await resolveCustomer(context, { required: true });
    const id = orderId(context.params);
    if (!id) throw new CustomerAuthError('INVALID_ORDER_ID', 'Order id is required');
    const order = await getCustomerOrder(auth.db, auth.user.id, id);
    if (!order) throw new CustomerAuthError('ORDER_NOT_FOUND', 'Order not found', 404);
    return json({ ok: true, order }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return customerApiError(error);
  }
}
