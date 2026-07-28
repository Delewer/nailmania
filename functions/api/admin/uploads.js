import { requireAdmin, requireSameOrigin } from '../../_lib/admin-auth.js';
import { apiError, handleApiError, json } from '../../_lib/http.js';
import { catalogRevisionBump } from '../../_lib/catalog-cache.js';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function imageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: 'jpg', contentType: 'image/jpeg' };
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { extension: 'png', contentType: 'image/png' };
  }
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    return { extension: 'webp', contentType: 'image/webp' };
  }
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp'
    && ['avif', 'avis'].includes(String.fromCharCode(...bytes.slice(8, 12)))) {
    return { extension: 'avif', contentType: 'image/avif' };
  }
  return null;
}

const publicImageUrl = (request, env, key) => {
  const publicBase = String(env.R2_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (publicBase) return `${publicBase}/${encodeURIComponent(key)}`;
  return `${new URL(request.url).origin}/api/media/${encodeURIComponent(key)}`;
};

export async function onRequestPost(context) {
  let uploadedKey = '';
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context);
    const bucket = context.env.PRODUCT_IMAGES;
    if (!bucket) return apiError('R2_NOT_CONFIGURED', 'Product image storage is not configured', 503);
    let form;
    try { form = await context.request.formData(); }
    catch { return apiError('INVALID_MULTIPART', 'Image upload must use multipart form data', 400); }
    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') return apiError('IMAGE_REQUIRED', 'Image file is required', 400);
    if (!file.size || file.size > MAX_IMAGE_BYTES) {
      return apiError('INVALID_IMAGE_SIZE', 'Image must be between 1 byte and 8 MB', 400);
    }
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const type = imageType(bytes);
    if (!type) return apiError('INVALID_IMAGE_TYPE', 'Only JPEG, PNG, WebP and AVIF images are allowed', 400);

    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    uploadedKey = `admin-${date}-${crypto.randomUUID()}.${type.extension}`;
    await bucket.put(uploadedKey, buffer, {
      httpMetadata: {
        contentType: type.contentType,
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: {
        uploadedBy: user.id,
        originalName: String(file.name || '').slice(0, 240),
      },
    });
    const url = publicImageUrl(context.request, context.env, uploadedKey);
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO admin_audit_log (
            id, actor_user_id, action, entity_type, entity_id, after_json, request_ip
          ) VALUES (?, ?, 'image.upload', 'image', ?, ?, ?)
        `).bind(
          `audit:${crypto.randomUUID()}`, user.id, uploadedKey,
          JSON.stringify({ objectKey: uploadedKey, url, contentType: type.contentType, size: file.size }),
          String(context.request.headers.get('cf-connecting-ip') || '').slice(0, 80),
        ),
        catalogRevisionBump(db),
      ]);
    } catch (error) {
      await bucket.delete(uploadedKey);
      uploadedKey = '';
      throw error;
    }
    return json({ ok: true, image: { url, objectKey: uploadedKey } }, 201, { 'cache-control': 'no-store' });
  } catch (error) {
    if (uploadedKey && context.env.PRODUCT_IMAGES) {
      try { await context.env.PRODUCT_IMAGES.delete(uploadedKey); } catch {}
    }
    return handleApiError(error);
  }
}
