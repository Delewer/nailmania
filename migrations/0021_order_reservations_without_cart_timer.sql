PRAGMA foreign_keys = ON;

-- Orders created before this migration from a server-reserved cart had already
-- committed their stock as a sale. Keep that historical lifecycle distinct;
-- every new order starts as a durable reservation and is sold on completion.
ALTER TABLE orders ADD COLUMN inventory_mode TEXT NOT NULL DEFAULT 'reservation'
  CHECK (inventory_mode IN ('reservation', 'sold_at_creation'));

UPDATE orders
SET inventory_mode = 'sold_at_creation'
WHERE cart_id IS NOT NULL;

-- A cart no longer reserves stock. Release every hold that can still be active
-- when this migration is applied and retain an auditable inventory movement.
UPDATE inventory
SET reserved = reserved - COALESCE((
      SELECT SUM(r.quantity)
      FROM cart_reservations r
      WHERE r.product_id = inventory.product_id AND r.status = 'ACTIVE'
    ), 0),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    admin_revision = 'migration:0021:cart-reservations-disabled'
WHERE warehouse_id = 1
  AND EXISTS (
    SELECT 1 FROM cart_reservations r
    WHERE r.product_id = inventory.product_id AND r.status = 'ACTIVE'
  );

INSERT INTO inventory_movements (
  id, product_id, warehouse_id, movement_type, delta_on_hand, delta_reserved,
  balance_on_hand, balance_reserved, reason, created_at
)
SELECT
  'cart-disable:' || r.product_id,
  r.product_id,
  1,
  'reservation_release',
  0,
  -SUM(r.quantity),
  i.on_hand,
  i.reserved,
  'Cart reservations disabled; stock is reserved only after checkout',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM cart_reservations r
JOIN inventory i ON i.product_id = r.product_id AND i.warehouse_id = 1
WHERE r.status = 'ACTIVE'
GROUP BY r.product_id
ON CONFLICT(id) DO NOTHING;

UPDATE cart_reservations
SET status = 'CANCELLED', order_id = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'ACTIVE';

-- Remove both reservation timers: carts never hold stock and open orders keep
-- their reservation until an explicit cancellation or a completed sale.
UPDATE orders
SET reservation_expires_at = NULL
WHERE reservation_expires_at IS NOT NULL
  AND status NOT IN ('completed', 'cancelled', 'returned');

DROP TRIGGER IF EXISTS order_items_cart_reservation_guard;
DROP TRIGGER IF EXISTS cart_reservations_active_product_insert_guard;
DROP TRIGGER IF EXISTS cart_reservations_active_product_update_guard;

-- D1's remote migrations endpoint requires CREATE TRIGGER to remain on one line.
CREATE TRIGGER cart_reservations_disabled_insert BEFORE INSERT ON cart_reservations WHEN NEW.status = 'ACTIVE' BEGIN SELECT RAISE(ABORT, 'cart reservations are disabled'); END;
CREATE TRIGGER cart_reservations_disabled_update BEFORE UPDATE OF status ON cart_reservations WHEN NEW.status = 'ACTIVE' BEGIN SELECT RAISE(ABORT, 'cart reservations are disabled'); END;

UPDATE catalog_cache_state
SET revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1
  AND EXISTS (
    SELECT 1 FROM inventory_movements WHERE id LIKE 'cart-disable:%'
  );
