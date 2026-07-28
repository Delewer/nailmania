import { requireAdmin } from '../../../_lib/admin-auth.js';
import { readAnalyticsMetrics } from '../../../_lib/analytics-reader.js';
import { handleApiError, json } from '../../../_lib/http.js';
import { parseStatisticsQuery } from '../../../_lib/statistics.js';

export async function onRequestGet(context) {
  try {
    await requireAdmin(context, ['manager', 'admin']);
    const range = parseStatisticsQuery(new URL(context.request.url).searchParams);
    const result = await readAnalyticsMetrics(context.env, range);
    return json({
      ok: true,
      period: { from: range.from, to: range.to, timezone: 'UTC', semantics: '[from,to)' },
      ...result,
    }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return handleApiError(error);
  }
}
