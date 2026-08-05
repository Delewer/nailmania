PRAGMA foreign_keys = ON;

-- A cancelled order releases its promo redemption. Reopening that order is
-- allowed to reactivate the same immutable commercial snapshot, but only
-- while the promo's current usage limits still have room.

CREATE TRIGGER promo_redemptions_reactivate_context
BEFORE UPDATE OF released_at, release_reason ON promo_redemptions
WHEN OLD.released_at IS NOT NULL
  AND NEW.released_at IS NULL
  AND (
    NEW.release_reason IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = OLD.order_id
        AND o.status = 'confirmed'
        AND o.transition_token IS NOT NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid promo reactivation');
END;

CREATE TRIGGER promo_redemptions_reactivate_login_guard
BEFORE UPDATE OF released_at, release_reason ON promo_redemptions
WHEN OLD.released_at IS NOT NULL
  AND NEW.released_at IS NULL
  AND EXISTS (
    SELECT 1 FROM promo_codes pc
    WHERE pc.id = OLD.promo_code_id
      AND pc.per_user_limit IS NOT NULL
      AND OLD.user_id IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'promo login required');
END;

CREATE TRIGGER promo_redemptions_reactivate_total_limit_guard
BEFORE UPDATE OF released_at, release_reason ON promo_redemptions
WHEN OLD.released_at IS NOT NULL
  AND NEW.released_at IS NULL
  AND EXISTS (
    SELECT 1 FROM promo_codes pc
    WHERE pc.id = OLD.promo_code_id
      AND pc.total_use_limit IS NOT NULL
      AND (
        SELECT COUNT(*) FROM promo_redemptions active
        WHERE active.promo_code_id = pc.id
          AND active.released_at IS NULL
          AND active.id <> OLD.id
      ) >= pc.total_use_limit
  )
BEGIN
  SELECT RAISE(ABORT, 'promo total limit reached');
END;

CREATE TRIGGER promo_redemptions_reactivate_user_limit_guard
BEFORE UPDATE OF released_at, release_reason ON promo_redemptions
WHEN OLD.released_at IS NOT NULL
  AND NEW.released_at IS NULL
  AND OLD.user_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM promo_codes pc
    WHERE pc.id = OLD.promo_code_id
      AND pc.per_user_limit IS NOT NULL
      AND (
        SELECT COUNT(*) FROM promo_redemptions active
        WHERE active.promo_code_id = pc.id
          AND active.user_id = OLD.user_id
          AND active.released_at IS NULL
          AND active.id <> OLD.id
      ) >= pc.per_user_limit
  )
BEGIN
  SELECT RAISE(ABORT, 'promo user limit reached');
END;

DROP TRIGGER promo_redemptions_immutable_update;

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
  OR NOT (
    (NEW.released_at IS OLD.released_at AND NEW.release_reason IS OLD.release_reason)
    OR (
      OLD.released_at IS NULL AND OLD.release_reason IS NULL
      AND NEW.released_at IS NOT NULL AND NEW.release_reason IS NOT NULL
    )
    OR (
      OLD.released_at IS NOT NULL AND OLD.release_reason IS NOT NULL
      AND NEW.released_at IS NULL AND NEW.release_reason IS NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'promo redemption records are immutable');
END;
