-- 003_ledger_rules.sql — rule kinds beyond budget (F3).
-- loop_guard and rate_limit live here; caps stay in cap_state.

CREATE TABLE IF NOT EXISTS ledger_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,
  scope_key   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  config      TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (scope, scope_key, kind)
);
