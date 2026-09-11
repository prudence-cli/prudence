-- 004_night_jobs.sql — Graveyard queue (N1).
-- Money in INTEGER micro-USD. Submission (batch_id) and results (N2) stay
-- null until the batch client runs.

CREATE TABLE IF NOT EXISTS night_jobs (
  id              TEXT PRIMARY KEY,
  project_path    TEXT NOT NULL,
  repo_snapshot   TEXT NOT NULL,
  base_sha        TEXT NOT NULL DEFAULT '',
  task_prompt     TEXT NOT NULL,
  model           TEXT NOT NULL,
  upstream        TEXT NOT NULL DEFAULT 'anthropic-batch',
  status          TEXT NOT NULL DEFAULT 'queued',
  batch_id        TEXT,
  result_pr_url   TEXT,
  est_cost_micro_usd   INTEGER,
  real_cost_micro_usd  INTEGER,
  queued_at       INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_night_jobs_status
  ON night_jobs(status, queued_at);
