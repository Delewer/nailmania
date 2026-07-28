ALTER TABLE orders ADD COLUMN return_revision TEXT;

ALTER TABLE order_items ADD COLUMN sold_quantity INTEGER NOT NULL DEFAULT 0
  CHECK (sold_quantity >= 0 AND sold_quantity <= quantity);

UPDATE order_items
SET sold_quantity = quantity
WHERE order_id IN (
  SELECT id FROM orders WHERE status IN ('completed', 'returned')
);

CREATE TRIGGER order_items_quantities_insert_guard
BEFORE INSERT ON order_items
WHEN NEW.returned_quantity < 0
  OR NEW.sold_quantity < 0
  OR NEW.returned_quantity > NEW.sold_quantity
  OR NEW.sold_quantity > NEW.quantity
BEGIN
  SELECT RAISE(ABORT, 'invalid order item sold/returned quantities');
END;

CREATE TRIGGER order_items_quantities_update_guard
BEFORE UPDATE OF quantity, sold_quantity, returned_quantity ON order_items
WHEN NEW.returned_quantity < 0
  OR NEW.sold_quantity < 0
  OR NEW.returned_quantity > NEW.sold_quantity
  OR NEW.sold_quantity > NEW.quantity
BEGIN
  SELECT RAISE(ABORT, 'invalid order item sold/returned quantities');
END;

CREATE TABLE order_returns (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  request_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  return_kind TEXT NOT NULL CHECK (return_kind IN ('partial', 'full')),
  items_amount INTEGER NOT NULL CHECK (items_amount >= 0),
  reason TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(order_id, request_key)
);

CREATE INDEX idx_order_returns_order_created
ON order_returns(order_id, created_at DESC, id DESC);

CREATE INDEX idx_order_returns_actor_created
ON order_returns(actor_user_id, created_at DESC);

CREATE TABLE order_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id TEXT NOT NULL REFERENCES order_returns(id) ON DELETE RESTRICT,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  line_amount INTEGER NOT NULL CHECK (line_amount >= 0),
  UNIQUE(return_id, order_item_id)
);

CREATE INDEX idx_order_return_items_order_item
ON order_return_items(order_item_id, return_id);

CREATE TRIGGER order_returns_immutable_update
BEFORE UPDATE ON order_returns
BEGIN
  SELECT RAISE(ABORT, 'order return records are immutable');
END;

CREATE TRIGGER order_returns_immutable_delete
BEFORE DELETE ON order_returns
BEGIN
  SELECT RAISE(ABORT, 'order return records are immutable');
END;

CREATE TRIGGER order_return_items_immutable_update
BEFORE UPDATE ON order_return_items
BEGIN
  SELECT RAISE(ABORT, 'order return item records are immutable');
END;

CREATE TRIGGER order_return_items_immutable_delete
BEFORE DELETE ON order_return_items
BEGIN
  SELECT RAISE(ABORT, 'order return item records are immutable');
END;

CREATE INDEX idx_inventory_movements_created
ON inventory_movements(created_at DESC, id DESC);

CREATE INDEX idx_inventory_movements_type_created
ON inventory_movements(movement_type, created_at DESC, id DESC);

CREATE INDEX idx_admin_audit_created
ON admin_audit_log(created_at DESC, id DESC);

CREATE INDEX idx_admin_audit_action_created
ON admin_audit_log(action, created_at DESC, id DESC);

CREATE INDEX idx_admin_audit_actor_created
ON admin_audit_log(actor_user_id, created_at DESC, id DESC);
