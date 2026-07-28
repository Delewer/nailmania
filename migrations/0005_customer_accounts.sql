ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN password_changed_at TEXT;

ALTER TABLE sessions ADD COLUMN revoked_at TEXT;
ALTER TABLE sessions ADD COLUMN ip_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_sessions_active_token
ON sessions(token_hash, expires_at)
WHERE revoked_at IS NULL;

CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  requested_ip_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_password_reset_user_created
ON password_reset_tokens(user_id, created_at DESC);

CREATE INDEX idx_password_reset_expiry
ON password_reset_tokens(expires_at)
WHERE used_at IS NULL;

CREATE UNIQUE INDEX idx_user_addresses_one_default
ON user_addresses(user_id)
WHERE is_default = 1;
