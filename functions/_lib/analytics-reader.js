export class AnalyticsReadError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'AnalyticsReadError';
    this.code = code;
    this.status = status;
  }
}

const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const DATASET = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function analyticsReaderConfig(env) {
  const accountId = String(env?.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const token = String(env?.ANALYTICS_READ_TOKEN || '').trim();
  const dataset = String(env?.PRODUCT_ANALYTICS_DATASET || '').trim();
  if (!accountId || !token || !dataset) return { configured: false };
  if (!ACCOUNT_ID.test(accountId) || !DATASET.test(dataset)) {
    throw new AnalyticsReadError('ANALYTICS_READER_INVALID_CONFIG', 'Analytics reader configuration is invalid', 503);
  }
  return { configured: true, accountId, token, dataset };
}

const sqlDate = (canonicalUtc) => canonicalUtc.slice(0, 19).replace('T', ' ');

export function analyticsMetricsSql(dataset, range) {
  if (!DATASET.test(dataset)) throw new AnalyticsReadError('ANALYTICS_READER_INVALID_CONFIG', 'Analytics dataset name is invalid', 503);
  const from = sqlDate(range.from);
  const to = sqlDate(range.to);
  return `SELECT blob1 AS event,
  SUM(_sample_interval) AS events,
  SUM(_sample_interval * double2) AS quantity_or_items,
  SUM(_sample_interval * double3) AS value_lei,
  SUM(_sample_interval * double4) AS result_count
FROM ${dataset}
WHERE timestamp >= toDateTime('${from}', 'Etc/UTC')
  AND timestamp < toDateTime('${to}', 'Etc/UTC')
GROUP BY blob1
ORDER BY event
FORMAT JSON`;
}

const number = (value) => Number(value || 0);
const percent = (numerator, denominator) => denominator
  ? Math.round((numerator / denominator) * 10_000) / 100
  : 0;

const metricsFromRows = (data) => {
  const rows = Object.fromEntries(data.map((row) => [String(row.event || ''), {
    events: number(row.events),
    quantityOrItems: number(row.quantity_or_items),
    value: number(row.value_lei),
    resultCount: number(row.result_count),
  }]));
  const views = rows.product_view?.events || 0;
  const addToCart = rows.add_to_cart?.events || 0;
  const checkoutStarted = rows.checkout_started?.events || 0;
  const ordersCreated = rows.order_created?.events || 0;
  return {
    views,
    addToCart,
    searches: rows.search?.events || 0,
    checkoutStarted,
    ordersCreated,
    addedUnits: rows.add_to_cart?.quantityOrItems || 0,
    orderValue: rows.order_created?.value || 0,
    searchResults: rows.search?.resultCount || 0,
    addToCartRate: percent(addToCart, views),
    checkoutConversionRate: percent(ordersCreated, checkoutStarted),
    orderConversionRate: percent(ordersCreated, views),
  };
};

export async function readD1AnalyticsMetrics(db, range) {
  const eventRows = await db.prepare(`
    SELECT event_type AS event,
           SUM(event_count) AS events,
           SUM(quantity_or_items) AS quantity_or_items,
           SUM(value_lei) AS value_lei,
           SUM(result_count) AS result_count
    FROM product_event_daily
    WHERE event_day >= ? AND event_day < ?
    GROUP BY event_type
    ORDER BY event_type
  `).bind(range.from.slice(0, 10), range.to.slice(0, 10)).all();
  const orderRow = await db.prepare(`
    SELECT 'order_created' AS event,
           COUNT(*) AS events,
           0 AS quantity_or_items,
           COALESCE(SUM(total_amount), 0) AS value_lei,
           0 AS result_count
    FROM orders
    WHERE created_at >= ? AND created_at < ?
  `).bind(range.from, range.to).first();
  return {
    configured: true,
    source: 'd1',
    metrics: metricsFromRows([...(eventRows.results || []), orderRow]),
  };
}

export async function readAnalyticsMetrics(env, range, options = {}) {
  if (env?.DB?.prepare) return readD1AnalyticsMetrics(env.DB, range);
  const config = analyticsReaderConfig(env);
  if (!config.configured) return { configured: false, metrics: null };
  const fetcher = options.fetch || fetch;
  const query = analyticsMetricsSql(config.dataset, range);
  let response;
  try {
    response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'text/plain; charset=utf-8',
          accept: 'application/json',
        },
        body: query,
        signal: options.signal || AbortSignal.timeout(8000),
      },
    );
  } catch {
    throw new AnalyticsReadError('ANALYTICS_READER_UNAVAILABLE', 'Analytics event metrics are temporarily unavailable');
  }
  if (!response.ok) {
    throw new AnalyticsReadError('ANALYTICS_READER_FAILED', 'Analytics event metrics could not be loaded');
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new AnalyticsReadError('ANALYTICS_READER_INVALID_RESPONSE', 'Analytics event metrics returned an invalid response'); }
  if (!Array.isArray(payload?.data)) {
    throw new AnalyticsReadError('ANALYTICS_READER_INVALID_RESPONSE', 'Analytics event metrics returned an invalid response');
  }
  return {
    configured: true,
    source: 'analytics-engine',
    metrics: metricsFromRows(payload.data),
  };
}
