CREATE TABLE rate_limit_buckets (
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1 CHECK (hits > 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key_hash, window_start)
);

CREATE INDEX idx_rate_limit_expiry ON rate_limit_buckets(expires_at);
