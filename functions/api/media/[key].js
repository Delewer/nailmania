import { apiError } from '../../_lib/http.js';

export async function onRequestGet({ env, params }) {
  const bucket = env.PRODUCT_IMAGES;
  if (!bucket) return apiError('R2_NOT_CONFIGURED', 'Image storage is not configured', 503);
  const key = decodeURIComponent(String(params.key || '')).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,240}$/.test(key)) return apiError('INVALID_IMAGE_KEY', 'Invalid image key', 400);
  const object = await bucket.get(key);
  if (!object) return apiError('IMAGE_NOT_FOUND', 'Image not found', 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', headers.get('cache-control') || 'public, max-age=31536000, immutable');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(object.body, { headers });
}
