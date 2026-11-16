import { completeAgedConfirmedOrders } from '../functions/_lib/order-lifecycle.js';
import { cleanupExpiredRateLimits } from '../functions/_lib/rate-limit.js';
import { cleanupCustomerAuthRecords } from '../functions/_lib/customer-maintenance.js';

const AUTO_COMPLETION_LIMIT = 20;

export default {
  async scheduled(controller, env) {
    if (!env?.DB) throw new Error('D1 binding DB is not configured');
    const now = new Date(controller.scheduledTime || Date.now()).toISOString();
    const completedOrders = await completeAgedConfirmedOrders(env.DB, {
      now,
      limit: AUTO_COMPLETION_LIMIT,
    });
    const rateLimits = await cleanupExpiredRateLimits(env.DB, { now: new Date(now) });
    const customerAuth = await cleanupCustomerAuthRecords(env.DB, { now: new Date(now) });
    console.log(JSON.stringify({
      event: 'scheduled_maintenance',
      cron: controller.cron,
      completedOrders,
      rateLimits,
      customerAuth,
    }));
    if (completedOrders.errors.length) {
      throw new Error(
        `Scheduled maintenance failed for ${completedOrders.errors.length} order operation(s)`,
      );
    }
  },
};
