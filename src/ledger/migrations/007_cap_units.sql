-- 007_cap_units.sql — P1 subscription passthrough.
-- Caps enforce in native units (usd | tokens | calls). Existing rows are
-- usd; their counters backfill 1:1 into the native columns.

ALTER TABLE cap_state ADD COLUMN unit TEXT NOT NULL DEFAULT 'usd';
ALTER TABLE cap_state ADD COLUMN limit_native INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cap_state ADD COLUMN spent_native INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cap_state ADD COLUMN reserved_native INTEGER NOT NULL DEFAULT 0;
UPDATE cap_state
  SET unit = 'usd',
      limit_native = limit_micro_usd,
      spent_native = spent_micro_usd,
      reserved_native = reserved_micro_usd;

ALTER TABLE usage_ledger ADD COLUMN cost_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_ledger ADD COLUMN reserved_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_ledger ADD COLUMN cost_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_ledger ADD COLUMN reserved_calls INTEGER NOT NULL DEFAULT 0;

ALTER TABLE refusal_events ADD COLUMN call_estimate_native INTEGER;

ALTER TABLE tallies ADD COLUMN amount_tokens INTEGER NOT NULL DEFAULT 0;
