import { requireAdmin } from '../../../_lib/admin-auth.js';
import { handleApiError, json } from '../../../_lib/http.js';
import { productionReadiness } from '../../../_lib/readiness.js';

export async function onRequestGet(context) {
  try {
    const { db } = await requireAdmin(context, ['admin']);
    const readiness = await productionReadiness(context.env, db);
    return json(readiness, readiness.ready ? 200 : 503, { 'cache-control': 'no-store' });
  } catch (error) {
    return handleApiError(error);
  }
}
