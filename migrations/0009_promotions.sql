PRAGMA foreign_keys = ON;

ALTER TABLE promo_codes ADD COLUMN admin_revision TEXT;

ALTER TABLE order_items ADD COLUMN promo_discount_allocation INTEGER NOT NULL DEFAULT 0
  CHECK (promo_discount_allocation >= 0 AND promo_discount_allocation <= line_total);

ALTER TABLE order_returns ADD COLUMN promo_refund_amount INTEGER NOT NULL DEFAULT 0
  CHECK (promo_refund_amount >= 0 AND promo_refund_amount <= items_amount);

ALTER TABLE order_return_items ADD COLUMN promo_refund_amount INTEGER NOT NULL DEFAULT 0
  CHECK (promo_refund_amount >= 0 AND promo_refund_amount <= line_amount);

ALTER TABLE promo_redemptions ADD COLUMN code_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE promo_redemptions ADD COLUMN discount_type_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE promo_redemptions ADD COLUMN discount_value_snapshot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE promo_redemptions ADD COLUMN eligible_subtotal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE promo_redemptions ADD COLUMN merchandise_subtotal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE promo_redemptions ADD COLUMN released_at TEXT;
ALTER TABLE promo_redemptions ADD COLUMN release_reason TEXT;

UPDATE promo_redemptions
SET code_snapshot = COALESCE((SELECT code FROM promo_codes WHERE id = promo_code_id), ''),
    discount_type_snapshot = COALESCE((SELECT discount_type FROM promo_codes WHERE id = promo_code_id), ''),
    discount_value_snapshot = COALESCE((SELECT discount_value FROM promo_codes WHERE id = promo_code_id), 0),
    merchandise_subtotal = COALESCE((SELECT items_subtotal FROM orders WHERE id = order_id), 0),
    eligible_subtotal = COALESCE((SELECT items_subtotal FROM orders WHERE id = order_id), 0);

CREATE TABLE promo_code_categories (
  promo_code_id TEXT NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (promo_code_id, category_id)
);

CREATE INDEX idx_promo_code_categories_category
ON promo_code_categories(category_id, promo_code_id);

CREATE TABLE promo_code_products (
  promo_code_id TEXT NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (promo_code_id, product_id)
);

CREATE INDEX idx_promo_code_products_product
ON promo_code_products(product_id, promo_code_id);

CREATE INDEX idx_promo_codes_active_dates
ON promo_codes(is_active, starts_at, ends_at, code);

CREATE INDEX idx_promo_redemptions_active_code
ON promo_redemptions(promo_code_id, created_at)
WHERE released_at IS NULL;

CREATE INDEX idx_promo_redemptions_active_user
ON promo_redemptions(promo_code_id, user_id, created_at)
WHERE released_at IS NULL AND user_id IS NOT NULL;

CREATE INDEX idx_promo_redemptions_released
ON promo_redemptions(released_at, promo_code_id)
WHERE released_at IS NOT NULL;

CREATE TRIGGER promo_codes_strict_insert
BEFORE INSERT ON promo_codes
WHEN length(NEW.code) < 3
  OR length(NEW.code) > 32
  OR NEW.code <> upper(trim(NEW.code))
  OR NEW.code GLOB '*[^A-Z0-9_-]*'
  OR (NEW.discount_type = 'percent' AND NEW.discount_value > 100)
  OR (NEW.discount_type = 'fixed' AND NEW.max_discount IS NOT NULL)
  OR (NEW.starts_at IS NOT NULL AND datetime(NEW.starts_at) IS NULL)
  OR (NEW.ends_at IS NOT NULL AND datetime(NEW.ends_at) IS NULL)
  OR (NEW.starts_at IS NOT NULL AND NEW.ends_at IS NOT NULL AND NEW.starts_at >= NEW.ends_at)
BEGIN
  SELECT RAISE(ABORT, 'invalid promo code definition');
END;

CREATE TRIGGER promo_codes_strict_update
BEFORE UPDATE OF code, discount_type, discount_value, max_discount, min_order_amount,
  starts_at, ends_at, total_use_limit, per_user_limit, is_active
ON promo_codes
WHEN length(NEW.code) < 3
  OR length(NEW.code) > 32
  OR NEW.code <> upper(trim(NEW.code))
  OR NEW.code GLOB '*[^A-Z0-9_-]*'
  OR (NEW.discount_type = 'percent' AND NEW.discount_value > 100)
  OR (NEW.discount_type = 'fixed' AND NEW.max_discount IS NOT NULL)
  OR (NEW.starts_at IS NOT NULL AND datetime(NEW.starts_at) IS NULL)
  OR (NEW.ends_at IS NOT NULL AND datetime(NEW.ends_at) IS NULL)
  OR (NEW.starts_at IS NOT NULL AND NEW.ends_at IS NOT NULL AND NEW.starts_at >= NEW.ends_at)
BEGIN
  SELECT RAISE(ABORT, 'invalid promo code definition');
END;

-- This view is the database-side authority used by the redemption trigger. A
-- product is eligible when there are no scopes, or when either its product or
-- category is explicitly included. The percent formula is integer half-up.
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
        )
        OR EXISTS (
          SELECT 1 FROM promo_code_products pp
          WHERE pp.promo_code_id = pc.id AND pp.product_id = oi.product_id
        )
        OR EXISTS (
          SELECT 1 FROM promo_code_categories pcg
          JOIN products p ON p.id = oi.product_id
          WHERE pcg.promo_code_id = pc.id AND pcg.category_id = p.category_id
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

CREATE TRIGGER promo_redemptions_validate_insert
BEFORE INSERT ON promo_redemptions
BEGIN
  SELECT RAISE(ABORT, 'promo validation failed')
  WHERE NOT EXISTS (
    SELECT 1
    FROM promo_order_calculations calc
    JOIN promo_codes pc ON pc.id = calc.promo_code_id
    JOIN orders o ON o.id = calc.order_id
    WHERE calc.order_id = NEW.order_id
      AND calc.promo_code_id = NEW.promo_code_id
      AND o.promo_discount = NEW.discount_amount
      AND o.items_subtotal = NEW.merchandise_subtotal
      AND calc.eligible_subtotal = NEW.eligible_subtotal
      AND calc.expected_discount = NEW.discount_amount
      AND calc.expected_discount > 0
      AND calc.code = NEW.code_snapshot
      AND calc.discount_type = NEW.discount_type_snapshot
      AND calc.discount_value = NEW.discount_value_snapshot
      AND pc.is_active = 1
      AND (pc.starts_at IS NULL OR pc.starts_at <= NEW.created_at)
      AND (pc.ends_at IS NULL OR pc.ends_at > NEW.created_at)
      AND o.items_subtotal >= pc.min_order_amount
      AND (o.user_id IS NEW.user_id)
  );

  SELECT RAISE(ABORT, 'promo login required')
  WHERE EXISTS (
    SELECT 1 FROM promo_codes pc
    WHERE pc.id = NEW.promo_code_id
      AND pc.per_user_limit IS NOT NULL
      AND NEW.user_id IS NULL
  );

  SELECT RAISE(ABORT, 'promo total limit reached')
  WHERE EXISTS (
    SELECT 1 FROM promo_codes pc
    WHERE pc.id = NEW.promo_code_id
      AND pc.total_use_limit IS NOT NULL
      AND (
        SELECT COUNT(*) FROM promo_redemptions pr
        WHERE pr.promo_code_id = pc.id AND pr.released_at IS NULL
      ) >= pc.total_use_limit
  );

  SELECT RAISE(ABORT, 'promo user limit reached')
  WHERE EXISTS (
    SELECT 1 FROM promo_codes pc
    WHERE pc.id = NEW.promo_code_id
      AND pc.per_user_limit IS NOT NULL
      AND NEW.user_id IS NOT NULL
      AND (
        SELECT COUNT(*) FROM promo_redemptions pr
        WHERE pr.promo_code_id = pc.id
          AND pr.user_id = NEW.user_id
          AND pr.released_at IS NULL
      ) >= pc.per_user_limit
  );
END;

CREATE TRIGGER promo_redemptions_immutable_delete
BEFORE DELETE ON promo_redemptions
BEGIN
  SELECT RAISE(ABORT, 'promo redemption records are immutable');
END;

CREATE TRIGGER promo_redemptions_immutable_update
BEFORE UPDATE ON promo_redemptions
WHEN NEW.id <> OLD.id
  OR NEW.promo_code_id <> OLD.promo_code_id
  OR NEW.order_id <> OLD.order_id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.discount_amount <> OLD.discount_amount
  OR NEW.created_at <> OLD.created_at
  OR NEW.code_snapshot <> OLD.code_snapshot
  OR NEW.discount_type_snapshot <> OLD.discount_type_snapshot
  OR NEW.discount_value_snapshot <> OLD.discount_value_snapshot
  OR NEW.eligible_subtotal <> OLD.eligible_subtotal
  OR NEW.merchandise_subtotal <> OLD.merchandise_subtotal
  OR (OLD.released_at IS NOT NULL AND NEW.released_at IS NOT OLD.released_at)
  OR (OLD.release_reason IS NOT NULL AND NEW.release_reason IS NOT OLD.release_reason)
  OR (NEW.released_at IS NULL AND NEW.release_reason IS NOT NULL)
  OR (NEW.released_at IS NOT NULL AND NEW.release_reason IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'promo redemption records are immutable');
END;
