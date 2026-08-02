PRAGMA foreign_keys = ON;

-- Catalog discounts are dynamic campaigns. They intentionally do not rewrite
-- products.price/source_type, so a future spreadsheet import can still update
-- imported products. Product/category/brand scopes form a union; an empty
-- scope matches nothing. When campaigns overlap, the largest percentage wins
-- (equivalent to the lowest effective price because all use products.price).
CREATE TABLE catalog_discounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 180),
  percentage INTEGER NOT NULL CHECK (percentage BETWEEN 1 AND 99),
  starts_at TEXT,
  ends_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  admin_revision TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_catalog_discounts_active_dates
ON catalog_discounts(is_active, starts_at, ends_at, created_at DESC);

CREATE TABLE catalog_discount_products (
  catalog_discount_id TEXT NOT NULL REFERENCES catalog_discounts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (catalog_discount_id, product_id)
);

CREATE INDEX idx_catalog_discount_products_product
ON catalog_discount_products(product_id, catalog_discount_id);

CREATE TABLE catalog_discount_categories (
  catalog_discount_id TEXT NOT NULL REFERENCES catalog_discounts(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON UPDATE CASCADE ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (catalog_discount_id, category_id)
);

CREATE INDEX idx_catalog_discount_categories_category
ON catalog_discount_categories(category_id, catalog_discount_id);

CREATE TABLE catalog_discount_brands (
  catalog_discount_id TEXT NOT NULL REFERENCES catalog_discounts(id) ON DELETE CASCADE,
  brand TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(brand)) BETWEEN 1 AND 180),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (catalog_discount_id, brand)
);

CREATE INDEX idx_catalog_discount_brands_brand
ON catalog_discount_brands(brand COLLATE NOCASE, catalog_discount_id);

CREATE TRIGGER catalog_discounts_strict_insert
BEFORE INSERT ON catalog_discounts
WHEN (NEW.starts_at IS NOT NULL AND datetime(NEW.starts_at) IS NULL)
  OR (NEW.ends_at IS NOT NULL AND datetime(NEW.ends_at) IS NULL)
  OR (NEW.starts_at IS NOT NULL AND NEW.ends_at IS NOT NULL AND NEW.starts_at >= NEW.ends_at)
BEGIN
  SELECT RAISE(ABORT, 'invalid catalog discount definition');
END;

CREATE TRIGGER catalog_discounts_strict_update
BEFORE UPDATE OF name, percentage, starts_at, ends_at, is_active
ON catalog_discounts
WHEN (NEW.starts_at IS NOT NULL AND datetime(NEW.starts_at) IS NULL)
  OR (NEW.ends_at IS NOT NULL AND datetime(NEW.ends_at) IS NULL)
  OR (NEW.starts_at IS NOT NULL AND NEW.ends_at IS NOT NULL AND NEW.starts_at >= NEW.ends_at)
BEGIN
  SELECT RAISE(ABORT, 'invalid catalog discount definition');
END;

CREATE VIEW product_catalog_prices AS
WITH priced AS (
  SELECT
    p.id AS product_id,
    p.price AS base_price,
    p.old_price AS base_old_price,
    p.is_promo AS base_is_promo,
    COALESCE((
      SELECT MAX(discount.percentage)
      FROM catalog_discounts discount
      WHERE discount.is_active = 1
        AND (discount.starts_at IS NULL OR discount.starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        AND (discount.ends_at IS NULL OR discount.ends_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        AND (
          EXISTS (
            SELECT 1 FROM catalog_discount_products scope
            WHERE scope.catalog_discount_id = discount.id AND scope.product_id = p.id
          )
          OR EXISTS (
            SELECT 1 FROM catalog_discount_categories scope
            WHERE scope.catalog_discount_id = discount.id AND scope.category_id = p.category_id
          )
          OR EXISTS (
            SELECT 1 FROM catalog_discount_brands scope
            WHERE scope.catalog_discount_id = discount.id AND scope.brand = p.brand COLLATE NOCASE
          )
        )
    ), 0) AS discount_percentage
  FROM products p
), effective AS (
  SELECT
    product_id,
    base_price,
    base_old_price,
    base_is_promo,
    discount_percentage,
    CASE
      WHEN discount_percentage > 0 THEN MAX(
        0,
        base_price - CAST((base_price * discount_percentage + 50) / 100 AS INTEGER)
      )
      ELSE base_price
    END AS effective_price
  FROM priced
)
SELECT
  product_id,
  base_price,
  base_old_price,
  discount_percentage,
  effective_price,
  CASE
    WHEN effective_price < base_price THEN MAX(base_old_price, base_price)
    ELSE base_old_price
  END AS effective_old_price,
  CASE WHEN discount_percentage > 0 THEN 1 ELSE base_is_promo END AS effective_is_promo
FROM effective;

-- Promo codes gain a durable brand scope. Keeping the brand itself (instead
-- of expanding it to product ids) also covers products imported later.
CREATE TABLE promo_code_brands (
  promo_code_id TEXT NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  brand TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(brand)) BETWEEN 1 AND 180),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (promo_code_id, brand)
);

CREATE INDEX idx_promo_code_brands_brand
ON promo_code_brands(brand COLLATE NOCASE, promo_code_id);

DROP VIEW promo_order_calculations;

CREATE VIEW promo_order_calculations AS
SELECT scoped.*,
  CASE
    WHEN scoped.discount_type = 'fixed'
      THEN min(scoped.discount_value, scoped.eligible_subtotal)
    ELSE min(
      CAST((scoped.eligible_subtotal * scoped.discount_value + 50) / 100 AS INTEGER),
      COALESCE(scoped.max_discount, scoped.eligible_subtotal),
      scoped.eligible_subtotal
    )
  END AS expected_discount
FROM (
  SELECT
    o.id AS order_id,
    o.user_id,
    o.promo_code_id,
    o.items_subtotal AS merchandise_subtotal,
    pc.code,
    pc.discount_type,
    pc.discount_value,
    pc.max_discount,
    COALESCE(SUM(
      CASE
        WHEN (
          NOT EXISTS (SELECT 1 FROM promo_code_products pp WHERE pp.promo_code_id = pc.id)
          AND NOT EXISTS (SELECT 1 FROM promo_code_categories pcg WHERE pcg.promo_code_id = pc.id)
          AND NOT EXISTS (SELECT 1 FROM promo_code_brands pb WHERE pb.promo_code_id = pc.id)
        )
        OR EXISTS (
          SELECT 1 FROM promo_code_products pp
          WHERE pp.promo_code_id = pc.id AND pp.product_id = oi.product_id
        )
        OR EXISTS (
          SELECT 1 FROM promo_code_categories pcg
          WHERE pcg.promo_code_id = pc.id AND pcg.category_id = oi.category_id_snapshot
        )
        OR EXISTS (
          SELECT 1 FROM promo_code_brands pb
          WHERE pb.promo_code_id = pc.id AND pb.brand = oi.brand COLLATE NOCASE
        )
        THEN oi.line_total
        ELSE 0
      END
    ), 0) AS eligible_subtotal
  FROM orders o
  JOIN promo_codes pc ON pc.id = o.promo_code_id
  JOIN order_items oi ON oi.order_id = o.id
  GROUP BY o.id, pc.id
) scoped;

-- The checkout guard must compare the order line with the same campaign-aware
-- price used by catalog, promo validation and the authoritative order quote.
DROP TRIGGER order_items_checkout_snapshot_guard;

CREATE TRIGGER order_items_checkout_snapshot_guard
BEFORE INSERT ON order_items
WHEN EXISTS (
  SELECT 1 FROM order_idempotency oi WHERE oi.order_id = NEW.order_id
)
AND NOT EXISTS (
  SELECT 1
  FROM products p
  JOIN product_catalog_prices prices ON prices.product_id = p.id
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
    AND prices.effective_price = NEW.unit_price
    AND CASE
      WHEN prices.effective_old_price > prices.effective_price THEN prices.effective_old_price
      ELSE prices.effective_price
    END = NEW.list_price
    AND NEW.line_total = NEW.unit_price * NEW.quantity
    AND p.is_active = 1
    AND p.deleted_at IS NULL
    AND c.is_active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'order commercial snapshot changed');
END;
