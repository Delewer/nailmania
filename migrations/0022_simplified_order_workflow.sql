PRAGMA foreign_keys = ON;

-- The simplified workflow confirms an order by moving it directly to the
-- internal completed state. Keep confirmed in the guard during a rolling
-- deployment so an older Pages bundle can still reopen an order safely.
DROP TRIGGER IF EXISTS promo_redemptions_reactivate_context;

-- Keep trigger bodies on one physical line because the remote D1 migration
-- endpoint rejects multiline CREATE TRIGGER statements.
CREATE TRIGGER promo_redemptions_reactivate_context BEFORE UPDATE OF released_at, release_reason ON promo_redemptions WHEN OLD.released_at IS NOT NULL AND NEW.released_at IS NULL AND (NEW.release_reason IS NOT NULL OR NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = OLD.order_id AND o.status IN ('confirmed', 'completed') AND o.transition_token IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'invalid promo reactivation'); END;
