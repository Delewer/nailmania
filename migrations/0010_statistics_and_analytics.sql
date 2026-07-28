PRAGMA foreign_keys = ON;

-- Immutable commercial dimensions used by historical reports.  Existing rows
-- are populated from the current catalogue only as a best-effort backfill;
-- every new order stores the values that were current when it was placed.
ALTER TABLE order_items ADD COLUMN category_id_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN category_name_ro_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN category_name_ru_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN cost_price_snapshot INTEGER
  CHECK (cost_price_snapshot IS NULL OR cost_price_snapshot >= 0);

UPDATE order_items
SET category_id_snapshot = COALESCE((
      SELECT p.category_id FROM products p WHERE p.id = order_items.product_id
    ), ''),
    category_name_ro_snapshot = COALESCE((
      SELECT c.name_ro
      FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.id = order_items.product_id
    ), ''),
    category_name_ru_snapshot = COALESCE((
      SELECT c.name_ru
      FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.id = order_items.product_id
    ), ''),
    cost_price_snapshot = (
      SELECT p.cost_price FROM products p WHERE p.id = order_items.product_id
    );

CREATE INDEX idx_orders_final_completed
ON orders(completed_at, id)
WHERE status IN ('completed', 'returned') AND completed_at IS NOT NULL;

CREATE INDEX idx_order_items_category_order
ON order_items(category_id_snapshot, order_id);

CREATE INDEX idx_order_items_brand_order
ON order_items(brand, order_id);

CREATE INDEX idx_order_returns_created_order
ON order_returns(created_at, order_id, id);
