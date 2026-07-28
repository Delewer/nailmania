export class OrderOperationError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'OrderOperationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

export async function updateOrderInternalComment(db, {
  orderId,
  comment,
  expectedRevision,
  actorUserId,
  now = new Date(),
}) {
  if (!db) throw new Error('D1 binding DB is not configured');
  const id = String(orderId || '').trim().slice(0, 120);
  if (!id) throw new OrderOperationError('INVALID_ORDER_ID', 'Order id is required');
  if (expectedRevision !== null && typeof expectedRevision !== 'string') {
    throw new OrderOperationError('INVALID_COMMENT_REVISION', 'Expected comment revision is invalid');
  }
  const normalizedRevision = expectedRevision === null ? null : expectedRevision.trim().slice(0, 100);
  const normalizedComment = String(comment ?? '').trim().slice(0, 2000);
  const current = await db.prepare(`
    SELECT id, internal_comment, internal_comment_revision
    FROM orders WHERE id = ? OR order_no = ? LIMIT 1
  `).bind(id, id).first();
  if (!current) throw new OrderOperationError('ORDER_NOT_FOUND', 'Order not found', 404);
  const currentRevision = current.internal_comment_revision || null;
  if (normalizedRevision !== currentRevision) {
    throw new OrderOperationError(
      'ORDER_COMMENT_CONFLICT',
      'The internal comment changed; reload the order before saving',
      409,
      { currentRevision },
    );
  }
  if (normalizedComment === String(current.internal_comment || '')) {
    return { changed: false, revision: currentRevision, comment: normalizedComment };
  }

  const nextRevision = crypto.randomUUID();
  const timestamp = new Date(now).toISOString();
  const auditId = crypto.randomUUID();
  const auditCommentState = (value, revision) => ({
    revision,
    present: Boolean(value),
    length: String(value || '').length,
  });
  const results = await db.batch([
    db.prepare(`
      UPDATE orders
      SET internal_comment = ?, internal_comment_revision = ?, updated_at = ?
      WHERE id = ?
        AND (
          (internal_comment_revision IS NULL AND ? IS NULL)
          OR internal_comment_revision = ?
        )
    `).bind(
      normalizedComment, nextRevision, timestamp, current.id,
      normalizedRevision, normalizedRevision,
    ),
    db.prepare(`
      INSERT INTO admin_audit_log (
        id, actor_user_id, action, entity_type, entity_id,
        before_json, after_json, request_ip, created_at
      )
      SELECT ?, ?, 'order.internal_comment.update', 'order', ?, ?, ?, '', ?
      WHERE EXISTS (
        SELECT 1 FROM orders WHERE id = ? AND internal_comment_revision = ?
      )
    `).bind(
      auditId,
      actorUserId || null,
      current.id,
      JSON.stringify(auditCommentState(current.internal_comment, currentRevision)),
      JSON.stringify(auditCommentState(normalizedComment, nextRevision)),
      timestamp,
      current.id,
      nextRevision,
    ),
  ]);
  if (changes(results?.[0]) !== 1) {
    throw new OrderOperationError(
      'ORDER_COMMENT_CONFLICT',
      'The internal comment changed; reload the order before saving',
      409,
    );
  }
  return { changed: true, revision: nextRevision, comment: normalizedComment };
}
