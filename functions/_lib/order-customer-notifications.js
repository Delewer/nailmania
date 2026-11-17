import { getOrderCustomerPayload } from './order-customer-payload.js';
import {
  deliverOrderCustomerNotification,
  logNotificationEvent,
} from './notifications.js';

export async function queueOrderCustomerNotification(context, options) {
  const requestId = context.data?.requestId || '';
  const task = Promise.resolve()
    .then(() => getOrderCustomerPayload(options.db, options.orderId, {
      returnId: options.returnId,
    }))
    .then((order) => {
      if (!order) throw new Error('Order customer notification payload is unavailable');
      if (!order.customer.email) return { skipped: true };
      return deliverOrderCustomerNotification({
        db: options.db,
        env: context.env,
        order,
        eventType: options.eventType,
        requestKey: options.requestKey,
        requestId,
        actorUserId: options.actorUserId || null,
      });
    })
    .catch(() => {
      logNotificationEvent({
        level: 'error',
        event: 'notification.email.persistence_failed',
        requestId,
        channel: 'email',
        eventType: options.eventType,
        orderNo: options.orderNo,
        code: 'NOTIFICATION_PERSISTENCE_FAILED',
      });
      return { failed: true };
    });

  if (typeof context.waitUntil === 'function') {
    context.waitUntil(task);
    return;
  }
  await task;
}
