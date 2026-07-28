import { handleApiError, json, requireDatabase } from '../_lib/http.js';
import {
  ProductEventError,
  recordProductEvent,
  requireProductEventSameOrigin,
} from '../_lib/product-events.js';

const MAX_EVENT_BYTES = 4096;

export async function onRequestPost(context) {
  try {
    requireProductEventSameOrigin(context.request, context.env);
    const contentType = String(context.request.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      throw new ProductEventError('INVALID_CONTENT_TYPE', 'Product events require application/json', 415);
    }
    const declaredSize = Number(context.request.headers.get('content-length') || 0);
    if (declaredSize > MAX_EVENT_BYTES) throw new ProductEventError('EVENT_TOO_LARGE', 'Product event exceeds 4096 bytes', 413);
    const raw = await context.request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_EVENT_BYTES) {
      throw new ProductEventError('EVENT_TOO_LARGE', 'Product event exceeds 4096 bytes', 413);
    }
    let input;
    try { input = JSON.parse(raw); }
    catch { throw new ProductEventError('INVALID_JSON', 'Request body must be valid JSON'); }
    if (String(input?.event || '').trim().toLowerCase() === 'order_created') {
      throw new ProductEventError(
        'SERVER_EVENT_ONLY',
        'order_created is recorded only by the order service after a successful database commit',
        403,
      );
    }
    const result = await recordProductEvent({ db: requireDatabase(context.env), env: context.env, input });
    return json({ ok: true, ...result }, 202, { 'cache-control': 'no-store' });
  } catch (error) {
    return handleApiError(error);
  }
}
