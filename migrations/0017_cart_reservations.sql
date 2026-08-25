PRAGMA foreign_keys = ON;

ALTER TABLE orders ADD COLUMN cart_id TEXT;

CREATE INDEX idx_orders_cart_id ON orders(cart_id, created_at DESC)
WHERE cart_id IS NOT NULL;

CREATE TABLE cart_reservations (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 99),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'CONVERTED', 'EXPIRED', 'CANCELLED')),
  expires_at TEXT NOT NULL,
  order_id TEXT REFERENCES orders(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(cart_id, product_id),
  CHECK ((status = 'CONVERTED' AND order_id IS NOT NULL)
      OR (status <> 'CONVERTED' AND order_id IS NULL))
);

CREATE INDEX idx_cart_reservations_expiry
ON cart_reservations(status, expires_at, id);

CREATE INDEX idx_cart_reservations_product_active
ON cart_reservations(product_id, expires_at, cart_id)
WHERE status = 'ACTIVE';

CREATE TRIGGER cart_reservations_active_product_insert_guard
BEFORE INSERT ON cart_reservations
WHEN NEW.status = 'ACTIVE' AND NOT EXISTS (
  SELECT 1
  FROM products p
  JOIN categories c ON c.id = p.category_id
  JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
  WHERE p.id = NEW.product_id AND p.is_active = 1
    AND p.deleted_at IS NULL AND c.is_active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'reservation product unavailable');
END;

CREATE TRIGGER cart_reservations_active_product_update_guard
BEFORE UPDATE OF status, product_id ON cart_reservations
WHEN NEW.status = 'ACTIVE' AND NOT EXISTS (
  SELECT 1
  FROM products p
  JOIN categories c ON c.id = p.category_id
  JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
  WHERE p.id = NEW.product_id AND p.is_active = 1
    AND p.deleted_at IS NULL AND c.is_active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'reservation product unavailable');
END;

CREATE TRIGGER cart_reservations_converted_immutable
BEFORE UPDATE ON cart_reservations
WHEN OLD.status = 'CONVERTED'
BEGIN
  SELECT RAISE(ABORT, 'converted cart reservation is immutable');
END;

CREATE TRIGGER order_items_cart_reservation_guard
BEFORE INSERT ON order_items
WHEN COALESCE((SELECT cart_id FROM orders WHERE id = NEW.order_id), '') <> ''
  AND NOT EXISTS (
    SELECT 1
    FROM orders o
    JOIN cart_reservations r
      ON r.cart_id = o.cart_id AND r.product_id = NEW.product_id
    WHERE o.id = NEW.order_id
      AND r.status = 'ACTIVE'
      AND r.quantity = NEW.quantity
      AND r.expires_at > o.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'active cart reservation required');
END;
