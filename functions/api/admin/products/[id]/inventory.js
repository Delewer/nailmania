import { requireAdmin, requireSameOrigin } from '../../../../_lib/admin-auth.js';
import {
  AdminProductError,
  changedRows,
  getAdminProduct,
  stockAdjustmentPlan,
} from '../../../../_lib/admin-products.js';
import { apiError, handleApiError, json } from '../../../../_lib/http.js';
import { catalogRevisionBump } from '../../../../_lib/catalog-cache.js';

const productId = (params) => decodeURIComponent(String(params.id || '')).trim().slice(0, 120);
const requestIp = (request) => String(request.headers.get('cf-connecting-ip') || '').slice(0, 80);

export async function onRequestPost(context) {
  try {
    requireSameOrigin(context.request, context.env);
    const { db, user } = await requireAdmin(context);
    const id = productId(context.params);
    if (!id) return apiError('INVALID_PRODUCT_ID', 'Product id is required', 400);
    let body;
    try { body = await context.request.json(); }
    catch { return apiError('INVALID_JSON', 'Request body must be valid JSON', 400); }
    if (!Object.hasOwn(body || {}, 'revision')) return apiError('INVENTORY_REVISION_REQUIRED', 'Inventory revision is required', 400);
    const product = await getAdminProduct(db, id);
    if (!product) return apiError('PRODUCT_NOT_FOUND', 'Product not found', 404);
    const plan = stockAdjustmentPlan(body, product);
    const expectedRevision = String(body.revision || '').slice(0, 120);
    const revision = crypto.randomUUID();
    const now = new Date().toISOString();
    const movementId = `stock:${revision}`;
    const beforeJson = JSON.stringify({ onHand: plan.currentOnHand, reserved: plan.reserved });
    const afterJson = JSON.stringify({ onHand: plan.nextOnHand, reserved: plan.reserved });
    const results = await db.batch([
      db.prepare(`
        UPDATE inventory
        SET on_hand = ?, updated_at = ?, admin_revision = ?
        WHERE product_id = ? AND warehouse_id = 1 AND COALESCE(admin_revision, '') = ?
      `).bind(plan.nextOnHand, now, revision, product.id, expectedRevision),
      db.prepare(`
        INSERT INTO inventory_movements (
          id, product_id, warehouse_id, movement_type, delta_on_hand, delta_reserved,
          balance_on_hand, balance_reserved, actor_user_id, reason, created_at
        )
        SELECT ?, product_id, warehouse_id, ?, ?, 0, on_hand, reserved, ?, ?, ?
        FROM inventory WHERE product_id = ? AND warehouse_id = 1 AND admin_revision = ?
      `).bind(movementId, plan.operation, plan.deltaOnHand, user.id, plan.reason, now, product.id, revision),
      db.prepare(`
        INSERT INTO admin_audit_log (
          id, actor_user_id, action, entity_type, entity_id, before_json, after_json, request_ip, created_at
        )
        SELECT ?, ?, ?, 'product', CAST(product_id AS TEXT), ?, ?, ?, ?
        FROM inventory WHERE product_id = ? AND warehouse_id = 1 AND admin_revision = ?
      `).bind(
        `audit:${crypto.randomUUID()}`, user.id, `inventory.${plan.operation}`,
        beforeJson, afterJson, requestIp(context.request), now, product.id, revision,
      ),
      catalogRevisionBump(
        db,
        'EXISTS (SELECT 1 FROM inventory WHERE product_id = ? AND warehouse_id = 1 AND admin_revision = ?)',
        [product.id, revision],
      ),
    ]);
    if (changedRows(results?.[0]) === 0) {
      return apiError('INVENTORY_REVISION_CONFLICT', 'Stock changed while this adjustment was being processed', 409);
    }
    const updatedProduct = await getAdminProduct(db, product.id);
    return json({ ok: true, product: updatedProduct, movement: updatedProduct.movements[0] }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    if (error instanceof AdminProductError) return apiError(error.code, error.message, error.status, error.details);
    return handleApiError(error);
  }
}
