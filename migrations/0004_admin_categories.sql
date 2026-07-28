ALTER TABLE categories ADD COLUMN source_type TEXT NOT NULL DEFAULT 'import'
  CHECK (source_type IN ('import', 'admin'));

ALTER TABLE categories ADD COLUMN admin_revision TEXT;

CREATE INDEX idx_categories_source_active
ON categories(source_type, is_active, sort_order, name_ro);
