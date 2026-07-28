import { requireAdmin, requireSameOrigin } from '../../../../_lib/admin-auth.js';
import { adminOrderForRole, getAdminOrder } from '../../../../_lib/admin-orders.js';
import { apiError, handleApiError, json } from '../../../../_lib/http.js';
import { createOrderReturn, OrderReturnError } from '../../../../_lib/order-returns.js';

const orderId = (params) => decodeURIComponent(String(params.id || '')).trim().slice(0, 120);

export async function onRequestPost(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context, ['manager', 'admin']);
    const id = orderId(context.params);
    if (!id) return apiError('INVALID_ORDER_ID', 'Order id is required', 400);
    let body;
    try { body = await context.request.json(); }
    catch { return apiError('INVALID_JSON', 'Request body must be valid JSON', 400); }
    const result = await createOrderReturn(db, {
      orderId: id,
      requestKey: context.request.headers.get('idempotency-key'),
      actorUserId: user.id,
      requestIp: context.request.headers.get('cf-connecting-ip'),
      reason: body?.reason,
      items: body?.items,
    });
    const order = await getAdminOrder(db, id);
    return json(
      {
        ok: true,
        created: result.created,
        return: result.return,
        order: adminOrderForRole(order, user.role),
      },
      result.created ? 201 : 200,
      { 'cache-control': 'no-store' },
    );
  } catch (error) {
    if (error instanceof OrderReturnError) return apiError(error.code, error.message, error.status, error.details);
    return handleApiError(error);
  }
}
