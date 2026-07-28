PRAGMA foreign_keys = ON;

-- Public checkout first stores its immutable idempotency record, reserves the
-- requested inventory and then inserts the order lines in the same D1 batch.
-- Re-check every commercial field at line-insert time so a catalog/admin edit
-- between the authoritative quote read and the batch cannot commit a stale
-- price or stale product snapshot. Direct historical/fixture inserts that do
-- not belong to the public idempotent checkout path remain unaffected.
CREATE TRIGGER order_items_checkout_snapshot_guard
BEFORE INSERT ON order_items
WHEN EXISTS (
  SELECT 1 FROM order_idempotency oi WHERE oi.order_id = NEW.order_id
)
AND NOT EXISTS (
  SELECT 1
  FROM products p
  JOIN categories c ON c.id = p.category_id
  JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = 1
  JOIN orders o ON o.id = NEW.order_id
  WHERE p.id = NEW.product_id
    AND p.catalog_key = NEW.product_key
    AND p.sku = NEW.sku
    AND p.brand = NEW.brand
    AND CASE
      WHEN o.language = 'ru' THEN COALESCE(NULLIF(p.name_ru, ''), p.name_ro)
      ELSE p.name_ro
    END = NEW.name
    AND p.category_id = NEW.category_id_snapshot
    AND c.name_ro = NEW.category_name_ro_snapshot
    AND c.name_ru = NEW.category_name_ru_snapshot
    AND p.cost_price IS NEW.cost_price_snapshot
    AND p.price = NEW.unit_price
    AND CASE WHEN p.old_price > p.price THEN p.old_price ELSE p.price END = NEW.list_price
    AND NEW.line_total = NEW.unit_price * NEW.quantity
    AND p.is_active = 1
    AND p.deleted_at IS NULL
    AND c.is_active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'order commercial snapshot changed');
END;
