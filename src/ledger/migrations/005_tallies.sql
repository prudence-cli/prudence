-- 005_tallies.sql — savings habit loop (N3).
-- Tallies record avoided spend as the product itself. Kinds:
-- 'night_discount' | 'loop_blocked' | 'compression_saving' | 'cache_hit'.

CREATE TABLE IF NOT EXISTS tallies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  amount_micro_usd  INTEGER NOT NULL,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tallies_kind
  ON tallies(kind, created_at);

ALTER TABLE night_jobs ADD COLUMN est_standard_micro_usd INTEGER;
