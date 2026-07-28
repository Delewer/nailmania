import { requireAdmin, requireSameOrigin } from '../../../../_lib/admin-auth.js';
import { getAdminOrder } from '../../../../_lib/admin-orders.js';
import { apiError, handleApiError, json } from '../../../../_lib/http.js';
import { OrderOperationError, updateOrderInternalComment } from '../../../../_lib/order-operations.js';

const orderId = (params) => decodeURIComponent(String(params.id || '')).trim().slice(0, 120);

export async function onRequestPatch(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context);
    const id = orderId(context.params);
    if (!id) return apiError('INVALID_ORDER_ID', 'Order id is required', 400);
    let body;
    try { body = await context.request.json(); }
    catch { return apiError('INVALID_JSON', 'Request body must be valid JSON', 400); }
    if (!body || Array.isArray(body) || typeof body !== 'object') {
      return apiError('INVALID_JSON', 'Request body must be a valid JSON object', 400);
    }
    if (!Object.hasOwn(body, 'expectedRevision')) {
      return apiError('COMMENT_REVISION_REQUIRED', 'Expected comment revision is required', 428);
    }
    const result = await updateOrderInternalComment(db, {
      orderId: id,
      comment: body.comment,
      expectedRevision: body.expectedRevision,
      actorUserId: user.id,
    });
    const order = await getAdminOrder(db, id);
    return json({ ok: true, result, order }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    if (error instanceof OrderOperationError) {
      return apiError(error.code, error.message, error.status, error.details);
    }
    return handleApiError(error);
  }
}
