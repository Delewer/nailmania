ALTER TABLE orders ADD COLUMN internal_comment_revision TEXT;

CREATE TABLE notification_attempts (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'email')),
  event_type TEXT NOT NULL CHECK (event_type IN ('order_created', 'order_resend', 'password_reset')),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('order', 'password_reset')),
  entity_id TEXT NOT NULL,
  order_id TEXT REFERENCES orders(id) ON DELETE RESTRICT,
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 200),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL DEFAULT '' CHECK (length(request_id) <= 100),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (entity_type = 'order' AND order_id IS NOT NULL AND entity_id = order_id)
    OR (entity_type = 'password_reset' AND order_id IS NULL)
  ),
  UNIQUE(channel, event_type, entity_type, entity_id, request_key)
);

CREATE INDEX idx_notification_attempts_order_created
ON notification_attempts(order_id, created_at DESC, id DESC);

CREATE INDEX idx_notification_attempts_entity_created
ON notification_attempts(entity_type, entity_id, created_at DESC, id DESC);

CREATE TABLE notification_attempt_statuses (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES notification_attempts(id) ON DELETE RESTRICT,
  phase TEXT NOT NULL CHECK (phase IN ('accepted', 'outcome')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  failure_code TEXT NOT NULL DEFAULT '' CHECK (length(failure_code) <= 80),
  provider_status INTEGER CHECK (provider_status IS NULL OR provider_status BETWEEN 100 AND 599),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (phase = 'accepted' AND status = 'pending' AND failure_code = '' AND provider_status IS NULL)
    OR (phase = 'outcome' AND status = 'sent' AND failure_code = '')
    OR (phase = 'outcome' AND status = 'failed' AND failure_code <> '')
  ),
  UNIQUE(attempt_id, phase)
);

CREATE INDEX idx_notification_status_failed_created
ON notification_attempt_statuses(status, created_at DESC)
WHERE status = 'failed';

CREATE TRIGGER notification_attempts_immutable_update
BEFORE UPDATE ON notification_attempts
BEGIN
  SELECT RAISE(ABORT, 'notification attempt records are immutable');
END;

CREATE TRIGGER notification_attempts_immutable_delete
BEFORE DELETE ON notification_attempts
BEGIN
  SELECT RAISE(ABORT, 'notification attempt records are immutable');
END;

CREATE TRIGGER notification_attempt_statuses_immutable_update
BEFORE UPDATE ON notification_attempt_statuses
BEGIN
  SELECT RAISE(ABORT, 'notification status records are immutable');
END;

CREATE TRIGGER notification_attempt_statuses_immutable_delete
BEFORE DELETE ON notification_attempt_statuses
BEGIN
  SELECT RAISE(ABORT, 'notification status records are immutable');
END;
