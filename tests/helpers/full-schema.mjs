import { readFileSync } from 'node:fs';

export const migrationNames = [
  '0001_initial.sql',
  '0002_order_transitions.sql',
  '0003_admin_products.sql',
  '0004_admin_categories.sql',
  '0005_customer_accounts.sql',
  '0006_returns_and_admin_journals.sql',
  '0007_catalog_cache.sql',
  '0008_rate_limits.sql',
  '0009_promotions.sql',
  '0010_statistics_and_analytics.sql',
  '0011_notifications_and_order_operations.sql',
  '0012_order_idempotency.sql',
  '0013_order_commercial_snapshot_guard.sql',
  '0014_catalog_discounts_and_promo_brands.sql',
  '0015_cancelled_order_reopening.sql',
  '0016_product_event_daily_rollups.sql',
];

export const fullSchema = migrationNames.map((name) => readFileSync(
  new URL(`../../migrations/${name}`, import.meta.url),
  'utf8',
)).join('\n');
