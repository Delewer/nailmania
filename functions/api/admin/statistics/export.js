import { requireAdmin } from '../../../_lib/admin-auth.js';
import { handleApiError } from '../../../_lib/http.js';
import { buildCsvReport, parseStatisticsQuery } from '../../../_lib/statistics.js';

const reportName = (value) => String(value || '').trim().toLowerCase();

export async function onRequestGet(context) {
  try {
    const { db } = await requireAdmin(context, ['manager', 'admin']);
    const url = new URL(context.request.url);
    const filters = parseStatisticsQuery(url.searchParams);
    const report = reportName(url.searchParams.get('report'));
    const csv = await buildCsvReport(db, filters, report);
    const fromDay = filters.from.slice(0, 10);
    const toDay = filters.to.slice(0, 10);
    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="nailmania-${report}-${fromDay}-${toDay}.csv"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
