import { requireAdmin, requireSameOrigin } from '../../../_lib/admin-auth.js';
import { apiError, handleApiError, json } from '../../../_lib/http.js';
import { catalogRevisionBump } from '../../../_lib/catalog-cache.js';

export async function onRequestDelete(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context);
    const bucket = context.env.PRODUCT_IMAGES;
    if (!bucket) return apiError('R2_NOT_CONFIGURED', 'Product image storage is not configured', 503);
    const key = decodeURIComponent(String(context.params.key || '')).trim();
    if (!/^admin-[A-Za-z0-9._-]{1,230}$/.test(key)) return apiError('INVALID_IMAGE_KEY', 'Only administrator uploads can be deleted', 400);
    const reference = await db.prepare('SELECT COUNT(*) AS count FROM product_images WHERE object_key = ?').bind(key).first();
    if (Number(reference?.count || 0) > 0) return apiError('IMAGE_IN_USE', 'Image is still attached to a product', 409);
    await bucket.delete(key);
    await db.batch([
      db.prepare(`
        INSERT INTO admin_audit_log (
          id, actor_user_id, action, entity_type, entity_id, before_json, request_ip
        ) VALUES (?, ?, 'image.delete', 'image', ?, ?, ?)
      `).bind(
        `audit:${crypto.randomUUID()}`, user.id, key, JSON.stringify({ objectKey: key }),
        String(context.request.headers.get('cf-connecting-ip') || '').slice(0, 80),
      ),
      catalogRevisionBump(db),
    ]);
    return json({ ok: true, deleted: true, objectKey: key }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    return handleApiError(error);
  }
}
