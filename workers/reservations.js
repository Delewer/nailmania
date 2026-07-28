import { releaseExpiredReservations } from '../functions/_lib/order-lifecycle.js';
import { cleanupExpiredRateLimits } from '../functions/_lib/rate-limit.js';
import { cleanupCustomerAuthRecords } from '../functions/_lib/customer-maintenance.js';

export default {
  async scheduled(controller, env) {
    if (!env?.DB) throw new Error('D1 binding DB is not configured');
    const now = new Date(controller.scheduledTime || Date.now()).toISOString();
    const summary = await releaseExpiredReservations(env.DB, { now, limit: 100 });
    const rateLimits = await cleanupExpiredRateLimits(env.DB, { now: new Date(now) });
    const customerAuth = await cleanupCustomerAuthRecords(env.DB, { now: new Date(now) });
    console.log(JSON.stringify({
      event: 'scheduled_maintenance',
      cron: controller.cron,
      reservations: summary,
      rateLimits,
      customerAuth,
    }));
    if (summary.errors.length) throw new Error(`Failed to release ${summary.errors.length} reservation(s)`);
  },
};
