import {
  completeAgedConfirmedOrders,
  releaseExpiredReservations,
} from '../functions/_lib/order-lifecycle.js';
import { releaseExpiredCartReservations } from '../functions/_lib/cart-reservations.js';
import { cleanupExpiredRateLimits } from '../functions/_lib/rate-limit.js';
import { cleanupCustomerAuthRecords } from '../functions/_lib/customer-maintenance.js';

const AUTO_COMPLETION_LIMIT = 20;

export default {
  async scheduled(controller, env) {
    if (!env?.DB) throw new Error('D1 binding DB is not configured');
    const now = new Date(controller.scheduledTime || Date.now()).toISOString();
    const summary = await releaseExpiredReservations(env.DB, { now, limit: 100 });
    const completedOrders = await completeAgedConfirmedOrders(env.DB, {
      now,
      limit: AUTO_COMPLETION_LIMIT,
    });
    const cartReservations = await releaseExpiredCartReservations(env.DB, { now, limit: 100 });
    const rateLimits = await cleanupExpiredRateLimits(env.DB, { now: new Date(now) });
    const customerAuth = await cleanupCustomerAuthRecords(env.DB, { now: new Date(now) });
    console.log(JSON.stringify({
      event: 'scheduled_maintenance',
      cron: controller.cron,
      reservations: summary,
      completedOrders,
      cartReservations,
      rateLimits,
      customerAuth,
    }));
    if (summary.errors.length || completedOrders.errors.length || cartReservations.errors.length) {
      throw new Error(
        `Scheduled maintenance failed for ${
          summary.errors.length + completedOrders.errors.length + cartReservations.errors.length
        } order or reservation operation(s)`,
      );
    }
  },
};
