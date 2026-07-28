import { requireAdmin, requireSameOrigin } from '../../../../../_lib/admin-auth.js';
import { adminOrderForRole, getAdminOrder } from '../../../../../_lib/admin-orders.js';
import { apiError, handleApiError, json } from '../../../../../_lib/http.js';
import {
  deliverTelegramNotification,
  expireStaleNotificationAttempts,
} from '../../../../../_lib/notifications.js';

const orderId = (params) => decodeURIComponent(String(params.id || '')).trim().slice(0, 120);

function idempotencyKey(request) {
  const value = String(request.headers.get('idempotency-key') || '').trim();
  if (value.length < 8 || value.length > 200 || !/^[\x21-\x7E]+$/.test(value)) return '';
  return value;
}

export async function onRequestPost(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context);
    const id = orderId(context.params);
    if (!id) return apiError('INVALID_ORDER_ID', 'Order id is required', 400);
    const requestKey = idempotencyKey(context.request);
    if (!requestKey) {
      return apiError(
        'IDEMPOTENCY_KEY_REQUIRED',
        'A valid Idempotency-Key header is required',
        400,
      );
    }
    const order = await getAdminOrder(db, id);
    if (!order) return apiError('ORDER_NOT_FOUND', 'Order not found', 404);
    await expireStaleNotificationAttempts(db, {
      channel: 'telegram',
      entityType: 'order',
      entityId: order.id,
    });
    const result = await deliverTelegramNotification({
      db,
      env: context.env,
      order: {
        ...order,
        discount: Number(order.catalogDiscount || 0) + Number(order.promoDiscount || 0),
      },
      eventType: 'order_resend',
      requestKey,
      requestId: context.data?.requestId || '',
      actorUserId: user.id,
      audit: {
        action: 'order.notification.telegram.resend',
        entityType: 'order',
        entityId: order.id,
      },
    });
    const updatedOrder = await getAdminOrder(db, order.id);
    return json(
      { ok: true, ...result, order: adminOrderForRole(updatedOrder, user.role) },
      result.created ? 201 : 200,
      { 'cache-control': 'no-store' },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
