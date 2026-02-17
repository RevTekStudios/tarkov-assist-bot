-- schema_items.sql
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  name_key TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_name_key ON items(name_key);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);