import { requireAdmin, requireSameOrigin } from '../../../_lib/admin-auth.js';
import { adminOrderForRole, getAdminOrder } from '../../../_lib/admin-orders.js';
import { apiError, handleApiError, json } from '../../../_lib/http.js';
import { OrderLifecycleError, transitionOrder } from '../../../_lib/order-lifecycle.js';

const orderId = (params) => decodeURIComponent(String(params.id || '')).trim().slice(0, 120);

export async function onRequestGet(context) {
  try {
    const { db, user } = await requireAdmin(context);
    const id = orderId(context.params);
    if (!id) return apiError('INVALID_ORDER_ID', 'Order id is required', 400);
    const order = await getAdminOrder(db, id);
    if (!order) return apiError('ORDER_NOT_FOUND', 'Order not found', 404);
    return json({ ok: true, order: adminOrderForRole(order, user.role) }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function onRequestPatch(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context);
    const id = orderId(context.params);
    if (!id) return apiError('INVALID_ORDER_ID', 'Order id is required', 400);
    let body;
    try { body = await context.request.json(); }
    catch { return apiError('INVALID_JSON', 'Request body must be valid JSON', 400); }
    const toStatus = String(body?.status || '').trim();
    const comment = String(body?.comment || '').trim().slice(0, 1000);
    const transition = await transitionOrder(db, {
      orderId: id,
      toStatus,
      actorUserId: user.id,
      comment,
    });
    const order = await getAdminOrder(db, id);
    return json({
      ok: true,
      transition,
      order: adminOrderForRole(order, user.role),
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    if (error instanceof OrderLifecycleError) {
      return apiError(error.code, error.message, error.status, error.details);
    }
    return handleApiError(error);
  }
}
