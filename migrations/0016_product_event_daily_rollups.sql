PRAGMA foreign_keys = ON;

-- Exact daily storefront counters. No customer identifiers, product keys or
-- search terms are stored in D1; completed order metrics come from orders.
CREATE TABLE product_event_daily (
  event_day TEXT NOT NULL CHECK (length(event_day) = 10),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'product_view', 'add_to_cart', 'search', 'checkout_started'
  )),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  quantity_or_items INTEGER NOT NULL DEFAULT 0 CHECK (quantity_or_items >= 0),
  value_lei INTEGER NOT NULL DEFAULT 0 CHECK (value_lei >= 0),
  result_count INTEGER NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_day, event_type)
) WITHOUT ROWID;
