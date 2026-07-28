import { requireAdmin } from '../../../_lib/admin-auth.js';
import { handleApiError, json } from '../../../_lib/http.js';
import { loadStatistics, parseStatisticsQuery } from '../../../_lib/statistics.js';

export async function onRequestGet(context) {
  try {
    const { db } = await requireAdmin(context, ['admin']);
    const filters = parseStatisticsQuery(new URL(context.request.url).searchParams);
    const report = await loadStatistics(db, filters);
    return json({ ok: true, ...report }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return handleApiError(error);
  }
}
