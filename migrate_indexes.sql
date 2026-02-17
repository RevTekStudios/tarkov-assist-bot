CREATE INDEX IF NOT EXISTS idx_watches_item ON watches(item_key);
CREATE INDEX IF NOT EXISTS idx_watches_user ON watches(user_id);