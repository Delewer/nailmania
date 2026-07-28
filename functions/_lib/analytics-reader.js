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
ORDER BY blob1
FORMAT JSON`;
}

const number = (value) => Number(value || 0);

export async function readAnalyticsMetrics(env, range, options = {}) {
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
  const rows = Object.fromEntries(payload.data.map((row) => [String(row.event || ''), {
    events: number(row.events),
    quantityOrItems: number(row.quantity_or_items),
    value: number(row.value_lei),
    resultCount: number(row.result_count),
  }]));
  const views = rows.product_view?.events || 0;
  const addToCart = rows.add_to_cart?.events || 0;
  const ordersCreated = rows.order_created?.events || 0;
  return {
    configured: true,
    metrics: {
      views,
      addToCart,
      searches: rows.search?.events || 0,
      checkoutStarted: rows.checkout_started?.events || 0,
      ordersCreated,
      addedUnits: rows.add_to_cart?.quantityOrItems || 0,
      orderValue: rows.order_created?.value || 0,
      searchResults: rows.search?.resultCount || 0,
      addToCartRate: views ? Math.round((addToCart / views) * 10_000) / 100 : 0,
      orderConversionRate: views ? Math.round((ordersCreated / views) * 10_000) / 100 : 0,
    },
  };
}
