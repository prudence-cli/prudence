-- 001_init.sql — Pru ledger rev.2 base schema.
-- Money in INTEGER micro-USD (1 USD = 1_000_000). No REAL money columns.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id            TEXT PRIMARY KEY,
  agent         TEXT NOT NULL,
  project_path  TEXT NOT NULL DEFAULT 'unknown',
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  status        TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_session_agent_project
  ON session(agent, project_path, status);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES session(id),
  upstream            TEXT NOT NULL,
  model               TEXT NOT NULL,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cached_tokens       INTEGER NOT NULL DEFAULT 0,
  tokens_saved        INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd      INTEGER NOT NULL DEFAULT 0,
  reserved_micro_usd  INTEGER NOT NULL DEFAULT 0,
  req_hash            TEXT,
  truth               TEXT NOT NULL DEFAULT 'unknown',
  status              TEXT NOT NULL DEFAULT 'reserved',
  created_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_usage_session
  ON usage_ledger(session_id, created_at);

CREATE TABLE IF NOT EXISTS cap_state (
  scope               TEXT NOT NULL,
  scope_key           TEXT NOT NULL,
  limit_micro_usd     INTEGER NOT NULL,
  spent_micro_usd     INTEGER NOT NULL DEFAULT 0,
  reserved_micro_usd  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, scope_key)
);

CREATE TABLE IF NOT EXISTS refusal_events (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id                TEXT NOT NULL REFERENCES session(id),
  type                      TEXT NOT NULL,
  spent_micro_usd           INTEGER NOT NULL DEFAULT 0,
  cap_micro_usd             INTEGER,
  call_estimate_micro_usd   INTEGER,
  req_hash                  TEXT,
  message                   TEXT NOT NULL,
  created_at                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refusal_session
  ON refusal_events(session_id, created_at);
