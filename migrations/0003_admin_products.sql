ALTER TABLE products ADD COLUMN source_type TEXT NOT NULL DEFAULT 'import'
  CHECK (source_type IN ('import', 'admin'));

ALTER TABLE products ADD COLUMN admin_revision TEXT;

ALTER TABLE inventory ADD COLUMN admin_revision TEXT;

CREATE INDEX idx_products_source_active
ON products(source_type, is_active, updated_at DESC);
