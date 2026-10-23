UPDATE products
SET is_featured = 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
  SELECT MIN(p.id)
  FROM products p
  JOIN categories c ON c.id = p.category_id AND c.is_active = 1
  WHERE p.is_active = 1 AND p.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM products WHERE is_featured = 1 AND is_active = 1 AND deleted_at IS NULL)
  GROUP BY p.category_id
  ORDER BY MIN(p.id)
  LIMIT 8
)
AND NOT EXISTS (SELECT 1 FROM products WHERE is_featured = 1 AND is_active = 1 AND deleted_at IS NULL);

UPDATE catalog_cache_state
SET revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 1 AND changes() > 0;
