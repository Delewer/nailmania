PRAGMA foreign_keys = ON;

-- The key, keyed business-request fingerprint and privacy-minimized successful
-- response are committed in the same transaction as the order and stock
-- reservation. Customer/contact data remains only on the authoritative order,
-- while a retry is safe even when the first HTTP response was lost after D1
-- committed.
CREATE TABLE order_idempotency (
  idempotency_key TEXT PRIMARY KEY CHECK (length(idempotency_key) = 36),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  response_json TEXT NOT NULL CHECK (
    json_valid(response_json)
    AND json_type(response_json, '$') = 'object'
    AND json_type(response_json, '$.customer') IS NULL
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

CREATE INDEX idx_order_idempotency_created
ON order_idempotency(created_at, order_id);

CREATE TRIGGER order_idempotency_immutable_update
BEFORE UPDATE ON order_idempotency
BEGIN
  SELECT RAISE(ABORT, 'order idempotency records are immutable');
END;

CREATE TRIGGER order_idempotency_immutable_delete
BEFORE DELETE ON order_idempotency
BEGIN
  SELECT RAISE(ABORT, 'order idempotency records are immutable');
END;
