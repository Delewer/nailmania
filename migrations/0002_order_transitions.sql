ALTER TABLE orders ADD COLUMN transition_token TEXT;

ALTER TABLE order_status_history ADD COLUMN transition_token TEXT;

CREATE UNIQUE INDEX idx_order_status_history_transition_token
ON order_status_history(transition_token)
WHERE transition_token IS NOT NULL;

CREATE INDEX idx_orders_transition_token ON orders(transition_token);
