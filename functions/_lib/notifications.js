import {
  passwordResetUrl,
  sendOrderConfirmationEmail,
  sendPasswordResetEmail,
} from './customer-email.js';
import { sendTelegramOrder } from './telegram.js';

const CHANNELS = new Set(['telegram', 'email']);
const EVENTS = new Set(['order_created', 'order_resend', 'password_reset']);
const ENTITY_TYPES = new Set(['order', 'password_reset']);
const TELEGRAM_FAILURE_CODES = new Set([
  'TELEGRAM_NOT_CONFIGURED',
  'TELEGRAM_TIMEOUT',
  'TELEGRAM_NETWORK_ERROR',
  'TELEGRAM_HTTP_ERROR',
  'TELEGRAM_PROVIDER_REJECTED',
]);
const EMAIL_FAILURE_CODES = new Set([
  'PASSWORD_RESET_NOT_CONFIGURED',
  'EMAIL_SERVICE_UNAVAILABLE',
  'EMAIL_TIMEOUT',
  'EMAIL_NETWORK_ERROR',
  'EMAIL_HTTP_ERROR',
  'EMAIL_PROVIDER_ERROR',
]);
const EXPIRED_ATTEMPT_CODE = 'NOTIFICATION_ATTEMPT_EXPIRED';
const DEFAULT_PENDING_LEASE_MS = 5 * 60 * 1000;
const MAX_RECOVERY_DEPTH = 16;

const safeString = (value, max) => String(value || '').trim().slice(0, max);
const safeRequestId = (value) => {
  const normalized = safeString(value, 100);
  return /^[A-Za-z0-9_-]{1,100}$/.test(normalized) ? normalized : '';
};
const safeProviderStatus = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : null;
};

function required(value, name, max = 200) {
  const normalized = safeString(value, max);
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function sanitizeFailure(error, channel) {
  const allowed = channel === 'telegram' ? TELEGRAM_FAILURE_CODES : EMAIL_FAILURE_CODES;
  const fallback = channel === 'telegram' ? 'TELEGRAM_DELIVERY_FAILED' : 'EMAIL_DELIVERY_FAILED';
  const candidate = safeString(error?.code, 80);
  return {
    code: allowed.has(candidate) ? candidate : fallback,
    providerStatus: safeProviderStatus(error?.providerStatus),
  };
}

export function logNotificationEvent({
  level = 'info', event, requestId, attemptId, channel, eventType, orderNo, code, providerStatus,
}) {
  const payload = {
    level,
    event,
    requestId: safeRequestId(requestId),
    attemptId: safeString(attemptId, 100),
    channel,
    eventType,
    ...(orderNo ? { orderNo: safeString(orderNo, 80) } : {}),
    ...(code ? { code: safeString(code, 80) } : {}),
    ...(safeProviderStatus(providerStatus) ? { providerStatus: safeProviderStatus(providerStatus) } : {}),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else console.log(line);
}

function normalizeAttempt(input) {
  const channel = required(input.channel, 'channel', 20);
  const eventType = required(input.eventType, 'eventType', 40);
  const entityType = required(input.entityType, 'entityType', 40);
  if (!CHANNELS.has(channel) || !EVENTS.has(eventType) || !ENTITY_TYPES.has(entityType)) {
    throw new TypeError('Notification attempt type is invalid');
  }
  const entityId = required(input.entityId, 'entityId', 200);
  const requestKey = required(input.requestKey, 'requestKey', 200);
  const orderId = entityType === 'order' ? required(input.orderId || entityId, 'orderId', 200) : null;
  if (entityType === 'order' && orderId !== entityId) throw new TypeError('Order notification entity is invalid');
  return {
    channel,
    eventType,
    entityType,
    entityId,
    orderId,
    requestKey,
    actorUserId: input.actorUserId ? safeString(input.actorUserId, 200) : null,
    requestId: safeRequestId(input.requestId),
    createdAt: input.createdAt ? new Date(input.createdAt).toISOString() : new Date().toISOString(),
  };
}

export async function getNotificationAttempt(db, attemptId) {
  const row = await db.prepare(`
    SELECT a.id, a.channel, a.event_type, a.entity_type, a.entity_id, a.order_id,
           a.actor_user_id, a.created_at, u.name AS actor_name, u.email AS actor_email,
           outcome.status, outcome.failure_code, outcome.provider_status,
           outcome.created_at AS completed_at
    FROM notification_attempts a
    LEFT JOIN users u ON u.id = a.actor_user_id
    LEFT JOIN notification_attempt_statuses outcome
      ON outcome.attempt_id = a.id AND outcome.phase = 'outcome'
    WHERE a.id = ?
    LIMIT 1
  `).bind(attemptId).first();
  if (!row) return null;
  return {
    id: row.id,
    channel: row.channel,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    orderId: row.order_id,
    status: row.status || 'pending',
    failureCode: row.failure_code || '',
    providerStatus: safeProviderStatus(row.provider_status),
    createdAt: row.created_at,
    completedAt: row.completed_at || null,
    actor: row.actor_user_id ? {
      id: row.actor_user_id,
      name: row.actor_name,
      email: row.actor_email,
    } : null,
  };
}

export async function claimNotificationAttempt(db, input) {
  if (!db) throw new Error('D1 binding DB is not configured');
  const attempt = normalizeAttempt(input);
  const generatedId = crypto.randomUUID();
  const acceptedStatusId = crypto.randomUUID();
  const statements = [
    db.prepare(`
      INSERT OR IGNORE INTO notification_attempts (
        id, channel, event_type, entity_type, entity_id, order_id, request_key,
        actor_user_id, request_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      generatedId, attempt.channel, attempt.eventType, attempt.entityType, attempt.entityId,
      attempt.orderId, attempt.requestKey, attempt.actorUserId, attempt.requestId, attempt.createdAt,
    ),
    db.prepare(`
      INSERT OR IGNORE INTO notification_attempt_statuses (
        id, attempt_id, phase, status, created_at
      )
      SELECT ?, ?, 'accepted', 'pending', ?
      WHERE EXISTS (SELECT 1 FROM notification_attempts WHERE id = ?)
    `).bind(acceptedStatusId, generatedId, attempt.createdAt, generatedId),
  ];

  if (input.audit) {
    const auditId = crypto.randomUUID();
    statements.push(db.prepare(`
      INSERT INTO admin_audit_log (
        id, actor_user_id, action, entity_type, entity_id,
        before_json, after_json, request_ip, created_at
      )
      SELECT ?, ?, ?, ?, ?, NULL, ?, '', ?
      WHERE EXISTS (SELECT 1 FROM notification_attempts WHERE id = ?)
    `).bind(
      auditId,
      input.actorUserId || null,
      required(input.audit.action, 'audit action', 100),
      required(input.audit.entityType, 'audit entity type', 80),
      required(input.audit.entityId, 'audit entity id', 200),
      JSON.stringify({ attemptId: generatedId, channel: attempt.channel, eventType: attempt.eventType }),
      attempt.createdAt,
      generatedId,
    ));
  }

  await db.batch(statements);
  const row = await db.prepare(`
    SELECT id FROM notification_attempts
    WHERE channel = ? AND event_type = ? AND entity_type = ? AND entity_id = ? AND request_key = ?
    LIMIT 1
  `).bind(
    attempt.channel, attempt.eventType, attempt.entityType, attempt.entityId, attempt.requestKey,
  ).first();
  if (!row) throw new Error('Notification attempt could not be persisted');
  return {
    created: row.id === generatedId,
    attempt: await getNotificationAttempt(db, row.id),
  };
}

export async function recordNotificationOutcome(db, attemptId, outcome, now = new Date()) {
  const status = outcome?.status === 'sent' ? 'sent' : 'failed';
  const failureCode = status === 'failed' ? required(outcome?.failureCode, 'failureCode', 80) : '';
  const providerStatus = safeProviderStatus(outcome?.providerStatus);
  await db.prepare(`
    INSERT OR IGNORE INTO notification_attempt_statuses (
      id, attempt_id, phase, status, failure_code, provider_status, created_at
    ) VALUES (?, ?, 'outcome', ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(), attemptId, status, failureCode, providerStatus,
    new Date(now).toISOString(),
  ).run();
  return getNotificationAttempt(db, attemptId);
}

export async function expireStaleNotificationAttempts(db, options = {}) {
  const channel = required(options.channel, 'channel', 20);
  const entityType = required(options.entityType, 'entityType', 40);
  const entityId = required(options.entityId, 'entityId', 200);
  if (!CHANNELS.has(channel) || !ENTITY_TYPES.has(entityType)) {
    throw new TypeError('Notification attempt type is invalid');
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const requestedLease = Number(options.pendingLeaseMs);
  const pendingLeaseMs = Number.isFinite(requestedLease) && requestedLease >= 1_000
    ? requestedLease
    : DEFAULT_PENDING_LEASE_MS;
  const cutoff = new Date(now.getTime() - pendingLeaseMs).toISOString();
  const result = await db.prepare(`
    INSERT OR IGNORE INTO notification_attempt_statuses (
      id, attempt_id, phase, status, failure_code, provider_status, created_at
    )
    SELECT 'expired:' || a.id, a.id, 'outcome', 'failed', ?, NULL, ?
    FROM notification_attempts a
    LEFT JOIN notification_attempt_statuses outcome
      ON outcome.attempt_id = a.id AND outcome.phase = 'outcome'
    WHERE a.channel = ? AND a.entity_type = ? AND a.entity_id = ?
      AND a.created_at <= ? AND outcome.attempt_id IS NULL
  `).bind(
    EXPIRED_ATTEMPT_CODE,
    now.toISOString(),
    channel,
    entityType,
    entityId,
    cutoff,
  ).run();
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

const pendingAttemptExpired = (attempt, now, leaseMs) => {
  if (attempt?.status !== 'pending') return false;
  const createdAt = Date.parse(attempt.createdAt || '');
  return Number.isFinite(createdAt) && now.getTime() - createdAt >= leaseMs;
};

async function claimRecoverableAttempt(db, input, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const requestedLease = Number(options.pendingLeaseMs);
  const pendingLeaseMs = Number.isFinite(requestedLease) && requestedLease >= 1_000
    ? requestedLease
    : DEFAULT_PENDING_LEASE_MS;
  let requestKey = input.requestKey;
  let audit = input.audit || null;

  for (let depth = 0; depth < MAX_RECOVERY_DEPTH; depth += 1) {
    const claimed = await claimNotificationAttempt(db, {
      ...input,
      requestKey,
      audit,
      createdAt: now.toISOString(),
    });
    audit = null;
    if (claimed.created) return claimed;

    let attempt = claimed.attempt;
    if (attempt.status === 'sent') return { created: false, attempt };
    if (attempt.status === 'failed' && attempt.failureCode !== EXPIRED_ATTEMPT_CODE) {
      return { created: false, attempt };
    }
    if (attempt.status === 'pending') {
      if (!pendingAttemptExpired(attempt, now, pendingLeaseMs)) {
        return { created: false, attempt };
      }
      attempt = await recordNotificationOutcome(db, attempt.id, {
        status: 'failed',
        failureCode: EXPIRED_ATTEMPT_CODE,
      }, now);
      if (attempt.status === 'sent') return { created: false, attempt };
      if (attempt.status !== 'failed' || attempt.failureCode !== EXPIRED_ATTEMPT_CODE) {
        return { created: false, attempt };
      }
      logNotificationEvent({
        level: 'error',
        event: 'notification.attempt.lease_expired',
        requestId: input.requestId,
        attemptId: attempt.id,
        channel: input.channel,
        eventType: input.eventType,
        code: EXPIRED_ATTEMPT_CODE,
      });
    }

    // A deterministic child key lets concurrent recovery requests race safely:
    // only one can claim the replacement attempt, while completed attempts are
    // still never sent twice.
    requestKey = `notification-recovery:${attempt.id}`;
  }
  throw new Error('Notification recovery chain is too deep');
}

export async function deliverTelegramNotification({
  db,
  env,
  order,
  eventType = 'order_created',
  requestKey,
  requestId = '',
  actorUserId = null,
  audit = null,
  timeoutMs,
  now,
  pendingLeaseMs,
  chatId,
}) {
  const claimed = await claimRecoverableAttempt(db, {
    channel: 'telegram',
    eventType,
    entityType: 'order',
    entityId: order.id,
    orderId: order.id,
    requestKey,
    requestId,
    actorUserId,
    audit,
  }, {
    now,
    pendingLeaseMs,
  });
  if (!claimed.created) return { created: false, delivered: claimed.attempt.status === 'sent', attempt: claimed.attempt };

  try {
    const result = await sendTelegramOrder(env, order, { timeoutMs, chatId });
    const attempt = await recordNotificationOutcome(db, claimed.attempt.id, {
      status: 'sent',
      providerStatus: result.providerStatus,
    });
    logNotificationEvent({
      event: 'notification.telegram.sent', requestId, attemptId: attempt.id,
      channel: 'telegram', eventType, orderNo: order.no, providerStatus: attempt.providerStatus,
    });
    return { created: true, delivered: true, attempt };
  } catch (error) {
    const failure = sanitizeFailure(error, 'telegram');
    const attempt = await recordNotificationOutcome(db, claimed.attempt.id, {
      status: 'failed', failureCode: failure.code, providerStatus: failure.providerStatus,
    });
    logNotificationEvent({
      level: 'error', event: 'notification.telegram.failed', requestId, attemptId: attempt.id,
      channel: 'telegram', eventType, orderNo: order.no,
      code: failure.code, providerStatus: failure.providerStatus,
    });
    return { created: true, delivered: false, attempt };
  }
}

export async function deliverOrderConfirmationNotification({
  db,
  env,
  order,
  requestKey,
  requestId = '',
  now,
  pendingLeaseMs,
}) {
  const claimed = await claimRecoverableAttempt(db, {
    channel: 'email',
    eventType: 'order_created',
    entityType: 'order',
    entityId: order.id,
    orderId: order.id,
    requestKey,
    requestId,
  }, {
    now,
    pendingLeaseMs,
  });
  if (!claimed.created) return { created: false, delivered: claimed.attempt.status === 'sent', attempt: claimed.attempt };

  try {
    await sendOrderConfirmationEmail(env, {
      email: order.customer.email,
      locale: order.lang,
      order,
      idempotencyKey: `order-confirmation-${order.id}`,
    });
    const attempt = await recordNotificationOutcome(db, claimed.attempt.id, { status: 'sent' });
    logNotificationEvent({
      event: 'notification.email.sent', requestId, attemptId: attempt.id,
      channel: 'email', eventType: 'order_created', orderNo: order.no,
    });
    return { created: true, delivered: true, attempt };
  } catch (error) {
    const failure = sanitizeFailure(error, 'email');
    const attempt = await recordNotificationOutcome(db, claimed.attempt.id, {
      status: 'failed', failureCode: failure.code, providerStatus: failure.providerStatus,
    });
    logNotificationEvent({
      level: 'error', event: 'notification.email.failed', requestId, attemptId: attempt.id,
      channel: 'email', eventType: 'order_created', orderNo: order.no,
      code: failure.code, providerStatus: failure.providerStatus,
    });
    return { created: true, delivered: false, attempt };
  }
}

export async function deliverPasswordResetNotification({
  db,
  env,
  request,
  tokenId,
  token,
  email,
  locale,
  expiresAt,
  requestId = '',
  now,
  pendingLeaseMs,
}) {
  const claimed = await claimRecoverableAttempt(db, {
    channel: 'email',
    eventType: 'password_reset',
    entityType: 'password_reset',
    entityId: tokenId,
    requestKey: `password-reset:${tokenId}`,
    requestId,
  }, {
    now,
    pendingLeaseMs,
  });
  if (!claimed.created) return { created: false, delivered: claimed.attempt.status === 'sent', attempt: claimed.attempt };

  try {
    await sendPasswordResetEmail(env, {
      email,
      locale,
      resetUrl: passwordResetUrl(request, env, token),
      expiresAt,
      idempotencyKey: `password-reset-${tokenId}`,
    });
    const attempt = await recordNotificationOutcome(db, claimed.attempt.id, { status: 'sent' });
    logNotificationEvent({
      event: 'notification.email.sent', requestId, attemptId: attempt.id,
      channel: 'email', eventType: 'password_reset',
    });
    return { created: true, delivered: true, attempt };
  } catch (error) {
    const failure = sanitizeFailure(error, 'email');
    const attempt = await recordNotificationOutcome(db, claimed.attempt.id, {
      status: 'failed', failureCode: failure.code, providerStatus: failure.providerStatus,
    });
    logNotificationEvent({
      level: 'error', event: 'notification.email.failed', requestId, attemptId: attempt.id,
      channel: 'email', eventType: 'password_reset', code: failure.code,
      providerStatus: failure.providerStatus,
    });
    return { created: true, delivered: false, attempt };
  }
}
