PRAGMA foreign_keys = ON;

-- Administrative conflict checks and legacy SKU lookups are intentionally
-- case-insensitive. The original binary SKU index cannot serve those queries,
-- which otherwise scan the entire product table for every product edit.
CREATE INDEX idx_products_sku_nocase
ON products(sku COLLATE NOCASE);
