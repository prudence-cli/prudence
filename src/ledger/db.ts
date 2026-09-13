// SQLite ledger: open, migrate, sessions, reservation lifecycle.
// All budget mutations run inside transactions. Money in integer micro-USD.

import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const MICRO_PER_USD = 1_000_000;

export function usdToMicro(usd: number): number {
  return Math.round(usd * MICRO_PER_USD);
}

// Display boundary only — never feed back into the ledger.
export function fmtUsd(microUsd: number): string {
  if (!(microUsd > 0)) return "$0.00";
  const usd = microUsd / MICRO_PER_USD;
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd >= 0.0001) return `$${usd.toFixed(4)}`;
  return `$${usd.toPrecision(2)}`;
}

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

export function ledgerPathDefault(): string {
  const home = process.env.HOME ?? ".";
  return process.env.PRU_DB ?? join(home, ".prudence", "ledger.db");
}

export function openLedger(path?: string): Database {
  const file = path ?? ledgerPathDefault();
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function appliedVersions(db: Database): Set<number> {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const rows = db
    .query("SELECT version FROM schema_migrations")
    .all() as { version: number }[];
  return new Set(rows.map((r) => r.version));
}

function migrate(db: Database): void {
  const done = appliedVersions(db);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );
  for (const file of files) {
    const version = Number(file.split("_")[0]);
    if (done.has(version)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const run = db.transaction(() => {
      db.exec(sql);
      insert.run(version, Date.now());
    });
    run();
  }
  seedDefaults(db);
}

// Armed-by-default rules. Caps are armed by `pru budget set`; the loop
// guard ships on (window 3) because a silent retry storm is the most
// expensive failure shape on record (PROGRESS §5 fatal 1+4).
function seedDefaults(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO ledger_rules (scope, scope_key, kind, config, enabled)
     VALUES ('global', '*', 'loop_guard', '{"window":3,"action":"alert"}', 1)`,
  ).run();
  // Compression ships on (plan §2.2 default config). "Transparent by default"
  // governs spend decisions — no caps, no refusals — while this documented,
  // counted, reversible pass trims noise before billing.
  db.prepare(
    `INSERT OR IGNORE INTO ledger_rules (scope, scope_key, kind, config, enabled)
     VALUES ('global', '*', 'compression', '{"strip":["logs","repeated_json","stack_traces"],"min_save_tokens":200}', 1)`,
  ).run();
}

export type SessionRow = {
  id: string;
  agent: string;
  project_path: string;
  started_at: number;
  ended_at: number | null;
  status: string;
};

// Sessions start empty and never inherit spend: one active session per
// agent+project; a new pair starts at zero.
export function ensureSession(
  db: Database,
  agent: string,
  projectPath: string,
): SessionRow {
  const a = agent || "unknown";
  const p = projectPath || "unknown";
  const existing = db
    .query("SELECT * FROM session WHERE agent = ? AND project_path = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1")
    .get(a, p) as SessionRow | null;
  if (existing) return existing;
  const row: SessionRow = {
    id: `sess_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    agent: a,
    project_path: p,
    started_at: Date.now(),
    ended_at: null,
    status: "active",
  };
  db.prepare(
    "INSERT INTO session (id, agent, project_path, started_at, ended_at, status) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.agent, row.project_path, row.started_at, null, row.status);
  return row;
}

export type CapUnit = "usd" | "tokens" | "calls";

export type CapRow = {
  scope: string;
  scope_key: string;
  limit_micro_usd: number;
  spent_micro_usd: number;
  reserved_micro_usd: number;
  unit: CapUnit;
  limit_native: number;
  spent_native: number;
  reserved_native: number;
};

// Costs of one call in every unit. Reservation checks each applicable cap
// in that cap's own unit.
export type CallCosts = {
  usd: number;
  tokens: number;
  calls: number;
};

// Resolution order session > project > global (plan §1.4). Every applicable
// cap must pass; the first breach in this order is the reported refusal.
export function applicableCaps(
  db: Database,
  session: SessionRow,
): CapRow[] {
  const rows = db.query("SELECT * FROM cap_state").all() as CapRow[];
  const ordered: CapRow[] = [];
  const by = (scope: string, key: string) =>
    rows.find((r) => r.scope === scope && r.scope_key === key);
  const s = by("session", session.id);
  if (s) ordered.push(s);
  const p = by("project", session.project_path);
  if (p) ordered.push(p);
  for (const r of rows) if (r.scope === "global") ordered.push(r);
  return ordered;
}

export type Refusal = {
  id: number;
  session_id: string;
  type: string;
  spent_micro_usd: number;
  cap_micro_usd: number | null;
  call_estimate_micro_usd: number | null;
  message: string;
  detail?: string | null;
};

export function reserveCall(
  db: Database,
  input: {
    session: SessionRow;
    upstream: string;
    model: string;
    costs: CallCosts;
    reqHash: string;
    tokensSaved?: number;
    detail?: string | null;
  },
): { ok: true; ledgerId: string } | { ok: false; refusal: Refusal } {
  const txn = db.transaction(() => {
    const caps = applicableCaps(db, input.session);
    for (const cap of caps) {
      const native = input.costs[cap.unit] ?? 0;
      if (cap.spent_native + cap.reserved_native + native > cap.limit_native) {
        const spent = cap.spent_native;
        const message =
          cap.unit === "usd"
            ? `Pru closed the ledger for this session (${fmtUsd(spent)} spent). ` +
              `Resume with: pru budget set 10 — or relax the watch: pru budget off.`
            : cap.unit === "calls"
              ? `Pru closed the ledger for this session (${spent} calls). ` +
                `Resume with: pru budget set 300 --unit calls — or relax the watch: pru budget off.`
              : `Pru closed the ledger for this session (${spent} tokens). ` +
                `Resume with: pru budget set 100000 --unit tokens — or relax the watch: pru budget off.`;
        const res = db
          .prepare(
            "INSERT INTO refusal_events (session_id, type, spent_micro_usd, cap_micro_usd, call_estimate_micro_usd, call_estimate_native, req_hash, message, detail, created_at) VALUES (?, 'budget_exhausted', ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            input.session.id,
            cap.unit === "usd" ? spent : 0,
            cap.unit === "usd" ? cap.limit_micro_usd : null,
            cap.unit === "usd" ? input.costs.usd : 0,
            native,
            input.reqHash,
            message,
            input.detail ?? null,
            Date.now(),
          );
        const refusal: Refusal = {
          id: Number(res.lastInsertRowid),
          session_id: input.session.id,
          type: "budget_exhausted",
          spent_micro_usd: cap.unit === "usd" ? spent : 0,
          cap_micro_usd: cap.unit === "usd" ? cap.limit_micro_usd : null,
          call_estimate_micro_usd: cap.unit === "usd" ? input.costs.usd : 0,
          message,
          detail: input.detail ?? null,
        };
        return { ok: false as const, refusal };
      }
    }
    for (const cap of caps) {
      const native = input.costs[cap.unit] ?? 0;
      if (cap.unit === "usd") {
        db.prepare(
          "UPDATE cap_state SET reserved_micro_usd = reserved_micro_usd + ?, reserved_native = reserved_native + ? WHERE scope = ? AND scope_key = ?",
        ).run(input.costs.usd, native, cap.scope, cap.scope_key);
      } else {
        db.prepare(
          "UPDATE cap_state SET reserved_native = reserved_native + ? WHERE scope = ? AND scope_key = ?",
        ).run(native, cap.scope, cap.scope_key);
      }
    }
    const ledgerId = `lr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    db.prepare(
      `INSERT INTO usage_ledger (id, session_id, upstream, model, reserved_micro_usd, reserved_tokens, reserved_calls, tokens_saved, req_hash, truth, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'envelope_estimate', 'reserved', ?)`,
    ).run(
      ledgerId,
      input.session.id,
      input.upstream,
      input.model,
      input.costs.usd,
      input.costs.tokens,
      input.tokensSaved ?? 0,
      input.reqHash,
      Date.now(),
    );
    return { ok: true as const, ledgerId };
  });
  return txn() as
    | { ok: true; ledgerId: string }
    | { ok: false; refusal: Refusal };
}

export type ReconcileInput = {
  ledgerId: string;
  costMicro: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  status?: string;
  truth?: string;
};

// One atomic lifecycle step: release this call's reservation, post its
// actuals. Only transitions out of 'reserved' — reconcile and abort are
// idempotent against each other, so a racing SSE tap and client-abort
// handler cannot double-release.
export function reconcileCall(db: Database, input: ReconcileInput): boolean {
  const txn = db.transaction(() => {
    const row = db
      .query("SELECT * FROM usage_ledger WHERE id = ?")
      .get(input.ledgerId) as
      | {
          session_id: string;
          reserved_micro_usd: number;
          reserved_tokens: number;
          reserved_calls: number;
          status: string;
        }
      | null;
    if (!row || row.status !== "reserved") return false;
    const session = db
      .query("SELECT * FROM session WHERE id = ?")
      .get(row.session_id) as SessionRow;
    const status = input.status ?? "ok";
    // Actuals in every unit. Calls post only on ok (consistent with the
    // posted-calls count); tokens post provider-reported actuals, else 0.
    const tokensActual =
      (input.inputTokens ?? 0) + (input.outputTokens ?? 0);
    const callsActual = status === "ok" ? 1 : 0;
    const caps = applicableCaps(db, session);
    for (const cap of caps) {
      if (cap.unit === "usd") {
        db.prepare(
          "UPDATE cap_state SET reserved_micro_usd = reserved_micro_usd - ?, spent_micro_usd = spent_micro_usd + ?, reserved_native = reserved_native - ?, spent_native = spent_native + ? WHERE scope = ? AND scope_key = ?",
        ).run(row.reserved_micro_usd, input.costMicro, row.reserved_micro_usd, input.costMicro, cap.scope, cap.scope_key);
      } else if (cap.unit === "tokens") {
        db.prepare(
          "UPDATE cap_state SET reserved_native = reserved_native - ?, spent_native = spent_native + ? WHERE scope = ? AND scope_key = ?",
        ).run(row.reserved_tokens, tokensActual, cap.scope, cap.scope_key);
      } else {
        db.prepare(
          "UPDATE cap_state SET reserved_native = reserved_native - ?, spent_native = spent_native + ? WHERE scope = ? AND scope_key = ?",
        ).run(row.reserved_calls, callsActual, cap.scope, cap.scope_key);
      }
    }
    db.prepare(
      `UPDATE usage_ledger SET cost_micro_usd = ?, reserved_micro_usd = 0,
        cost_tokens = ?, reserved_tokens = 0,
        cost_calls = ?, reserved_calls = 0,
        input_tokens = ?, output_tokens = ?, cached_tokens = ?,
        status = ?, truth = ?, completed_at = ? WHERE id = ?`,
    ).run(
      input.costMicro,
      tokensActual,
      callsActual,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.cachedTokens ?? 0,
      status,
      input.truth ?? "provider_usage",
      Date.now(),
      input.ledgerId,
    );
    return true;
  });
  return txn() as boolean;
}

// Abort path: no trustworthy actuals (F4 estimates from accumulated deltas;
// F2 posts zero). Reservation is released, row marked aborted.
export function abortCall(db: Database, ledgerId: string): boolean {
  return reconcileCall(db, {
    ledgerId,
    costMicro: 0,
    status: "aborted",
    truth: "aborted",
  });
}

export function insertRefusal(
  db: Database,
  input: {
    sessionId: string;
    type: string;
    spentMicro: number;
    capMicro?: number | null;
    callEstimateMicro?: number | null;
    reqHash?: string | null;
    message: string;
    detail?: string | null;
  },
): Refusal {
  const res = db
    .prepare(
      "INSERT INTO refusal_events (session_id, type, spent_micro_usd, cap_micro_usd, call_estimate_micro_usd, req_hash, message, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      input.sessionId,
      input.type,
      input.spentMicro,
      input.capMicro ?? null,
      input.callEstimateMicro ?? null,
      input.reqHash ?? null,
      input.message,
      input.detail ?? null,
      Date.now(),
    );
  return {
    id: Number(res.lastInsertRowid),
    session_id: input.sessionId,
    type: input.type,
    spent_micro_usd: input.spentMicro,
    cap_micro_usd: input.capMicro ?? null,
    call_estimate_micro_usd: input.callEstimateMicro ?? null,
    message: input.message,
    detail: input.detail ?? null,
  };
}

export function setCap(
  db: Database,
  scope: string,
  scopeKey: string,
  limitNative: number,
  unit: CapUnit = "usd",
): void {
  // limitNative is micro-USD for usd caps, counts otherwise. Re-arming
  // moves the limit only — spend stands still (regression-pinned).
  const limitMicro = unit === "usd" ? Math.round(limitNative) : 0;
  const existing = getCap(db, scope, scopeKey);
  db.prepare(
    `INSERT INTO cap_state (scope, scope_key, limit_micro_usd, spent_micro_usd, reserved_micro_usd, unit, limit_native, spent_native, reserved_native)
     VALUES (?, ?, ?, 0, 0, ?, ?, 0, 0)
     ON CONFLICT (scope, scope_key) DO UPDATE SET limit_micro_usd = excluded.limit_micro_usd, unit = excluded.unit, limit_native = excluded.limit_native`,
  ).run(scope, scopeKey, limitMicro, unit, Math.round(limitNative));
  if (existing && existing.unit !== unit) {
    // New currency, empty coffers: old counts are meaningless in the new unit.
    db.prepare(
      "UPDATE cap_state SET spent_micro_usd = 0, reserved_micro_usd = 0, spent_native = 0, reserved_native = 0 WHERE scope = ? AND scope_key = ?",
    ).run(scope, scopeKey);
  }
}

export function clearCap(db: Database, scope: string, scopeKey: string): boolean {
  const res = db
    .prepare("DELETE FROM cap_state WHERE scope = ? AND scope_key = ?")
    .run(scope, scopeKey);
  return res.changes > 0;
}

export function getCap(db: Database, scope: string, scopeKey: string): CapRow | null {
  return db
    .query("SELECT * FROM cap_state WHERE scope = ? AND scope_key = ?")
    .get(scope, scopeKey) as CapRow | null;
}

export type StatusView = {
  session: SessionRow;
  caps: CapRow[];
  spent_micro_usd: number;
  spent_tokens: number;
  calls: number;
  refusals: Refusal[];
};

export function formatCapAmount(value: number, unit: CapUnit): string {
  if (unit === "usd") return fmtUsd(value);
  return `${value.toLocaleString("en-US")} ${unit}`;
}

export function getStatus(db: Database, sessionId?: string): StatusView | null {
  const session = sessionId
    ? (db.query("SELECT * FROM session WHERE id = ?").get(sessionId) as SessionRow | null)
    : (db
        .query("SELECT * FROM session WHERE status = 'active' ORDER BY started_at DESC LIMIT 1")
        .get() as SessionRow | null);
  if (!session) return null;
  const caps = applicableCaps(db, session);
  const totals = db
    .query(
      "SELECT COUNT(*) AS n, COALESCE(SUM(cost_micro_usd), 0) AS spent, COALESCE(SUM(cost_tokens), 0) AS tokens FROM usage_ledger WHERE session_id = ? AND status = 'ok'",
    )
    .get(session.id) as { n: number; spent: number; tokens: number };
  const refusals = db
    .query("SELECT * FROM refusal_events WHERE session_id = ? ORDER BY created_at DESC LIMIT 5")
    .all(session.id) as Refusal[];
  return {
    session,
    caps,
    spent_micro_usd: totals.spent,
    spent_tokens: totals.tokens,
    calls: totals.n,
    refusals,
  };
}

export type RuleRow = {
  id: number;
  scope: string;
  scope_key: string;
  kind: string;
  config: string;
  enabled: number;
};

export function setRule(
  db: Database,
  scope: string,
  scopeKey: string,
  kind: string,
  config: Record<string, unknown>,
  enabled = 1,
): void {
  db.prepare(
    `INSERT INTO ledger_rules (scope, scope_key, kind, config, enabled)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (scope, scope_key, kind)
     DO UPDATE SET config = excluded.config, enabled = excluded.enabled`,
  ).run(scope, scopeKey, kind, JSON.stringify(config), enabled ? 1 : 0);
}

export function getRule(
  db: Database,
  kind: string,
  scope = "global",
  scopeKey = "*",
): { config: Record<string, unknown>; enabled: boolean } | null {
  const row = db
    .query("SELECT * FROM ledger_rules WHERE kind = ? AND scope = ? AND scope_key = ?")
    .get(kind, scope, scopeKey) as RuleRow | null;
  if (!row) return null;
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(row.config) as Record<string, unknown>;
  } catch {
    config = {};
  }
  return { config, enabled: row.enabled !== 0 };
}

// Same session > project > global order as caps; enabled rows only.
export function applicableRules(
  db: Database,
  kind: string,
  session: SessionRow,
): { scope: string; scope_key: string; config: Record<string, unknown> }[] {
  const rows = db
    .query("SELECT * FROM ledger_rules WHERE kind = ? AND enabled != 0")
    .all(kind) as RuleRow[];
  const parsed = rows.map((r) => {
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(r.config) as Record<string, unknown>;
    } catch {
      config = {};
    }
    return { scope: r.scope, scope_key: r.scope_key, config };
  });
  const ordered: typeof parsed = [];
  const s = parsed.find((r) => r.scope === "session" && r.scope_key === session.id);
  if (s) ordered.push(s);
  const p = parsed.find((r) => r.scope === "project" && r.scope_key === session.project_path);
  if (p) ordered.push(p);
  for (const r of parsed) if (r.scope === "global") ordered.push(r);
  return ordered;
}

export function loopWindow(db: Database): number {
  const rule = getRule(db, "loop_guard");
  const w = rule ? Number(rule.config.window) : NaN;
  if (!rule || !rule.enabled) return Number.POSITIVE_INFINITY;
  return Number.isFinite(w) && w > 0 ? Math.floor(w) : 3;
}

export function sessionSpentMicro(db: Database, sessionId: string): number {
  const row = db
    .query("SELECT COALESCE(SUM(cost_micro_usd), 0) AS spent FROM usage_ledger WHERE session_id = ? AND status = 'ok'")
    .get(sessionId) as { spent: number };
  return row.spent;
}

// Posted actuals plus in-flight reservations inside the trailing window.
// In-flight counts: a burst of concurrent calls must trip the pace even
// before any of them reconciles.
export function minuteSpendMicro(
  db: Database,
  sessionId: string,
  windowMs = 60_000,
): number {
  const row = db
    .query(
      `SELECT COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_micro_usd ELSE cost_micro_usd END), 0) AS m
       FROM usage_ledger WHERE session_id = ? AND created_at > ? AND status IN ('ok', 'reserved')`,
    )
    .get(sessionId, Date.now() - windowMs) as { m: number };
  return row.m;
}

export type NightJobRow = {
  id: string;
  project_path: string;
  repo_snapshot: string;
  base_sha: string;
  task_prompt: string;
  model: string;
  upstream: string;
  status: string;
  batch_id: string | null;
  result_pr_url: string | null;
  est_cost_micro_usd: number | null;
  real_cost_micro_usd: number | null;
  queued_at: number;
  finished_at: number | null;
  est_standard_micro_usd?: number | null;
};

export function queueNightJob(
  db: Database,
  input: {
    projectPath: string;
    repoSnapshot: string;
    baseSha: string;
    taskPrompt: string;
    model: string;
    upstream?: string;
    estCostMicro?: number | null;
    estStandardMicro?: number | null;
  },
): NightJobRow {
  const row: NightJobRow = {
    id: `nj_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    project_path: input.projectPath,
    repo_snapshot: input.repoSnapshot,
    base_sha: input.baseSha,
    task_prompt: input.taskPrompt,
    model: input.model,
    upstream: input.upstream ?? "anthropic-batch",
    status: "queued",
    batch_id: null,
    result_pr_url: null,
    est_cost_micro_usd: input.estCostMicro ?? null,
    real_cost_micro_usd: null,
    queued_at: Date.now(),
    finished_at: null,
    est_standard_micro_usd: input.estStandardMicro ?? null,
  };
  db.prepare(
    `INSERT INTO night_jobs (id, project_path, repo_snapshot, base_sha, task_prompt, model, upstream, status, batch_id, result_pr_url, est_cost_micro_usd, real_cost_micro_usd, queued_at, finished_at, est_standard_micro_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.project_path, row.repo_snapshot, row.base_sha, row.task_prompt,
    row.model, row.upstream, row.status, row.batch_id, row.result_pr_url,
    row.est_cost_micro_usd, row.real_cost_micro_usd, row.queued_at, row.finished_at,
    row.est_standard_micro_usd ?? null,
  );
  return row;
}

export function listNightJobs(db: Database, status?: string): NightJobRow[] {
  if (status) {
    return db.query("SELECT * FROM night_jobs WHERE status = ? ORDER BY queued_at DESC").all(status) as NightJobRow[];
  }
  return db.query("SELECT * FROM night_jobs ORDER BY queued_at DESC").all() as NightJobRow[];
}

export function getNightJob(db: Database, id: string): NightJobRow | null {
  return db.query("SELECT * FROM night_jobs WHERE id = ?").get(id) as NightJobRow | null;
}

export function updateNightJob(
  db: Database,
  id: string,
  patch: {
    status?: string;
    batch_id?: string | null;
    real_cost_micro_usd?: number | null;
    finished_at?: number | null;
    repo_snapshot?: string;
    base_sha?: string;
    est_cost_micro_usd?: number | null;
    est_standard_micro_usd?: number | null;
    result_pr_url?: string | null;
  },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    vals.push(patch.status);
  }
  if (patch.batch_id !== undefined) {
    sets.push("batch_id = ?");
    vals.push(patch.batch_id);
  }
  if (patch.real_cost_micro_usd !== undefined) {
    sets.push("real_cost_micro_usd = ?");
    vals.push(patch.real_cost_micro_usd);
  }
  if (patch.finished_at !== undefined) {
    sets.push("finished_at = ?");
    vals.push(patch.finished_at);
  }
  if (patch.repo_snapshot !== undefined) {
    sets.push("repo_snapshot = ?");
    vals.push(patch.repo_snapshot);
  }
  if (patch.base_sha !== undefined) {
    sets.push("base_sha = ?");
    vals.push(patch.base_sha);
  }
  if (patch.est_cost_micro_usd !== undefined) {
    sets.push("est_cost_micro_usd = ?");
    vals.push(patch.est_cost_micro_usd);
  }
  if (patch.est_standard_micro_usd !== undefined) {
    sets.push("est_standard_micro_usd = ?");
    vals.push(patch.est_standard_micro_usd);
  }
  if (patch.result_pr_url !== undefined) {
    sets.push("result_pr_url = ?");
    vals.push(patch.result_pr_url);
  }
  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE night_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as []));
}

export type TallyRow = {
  id: number;
  kind: string;
  amount_micro_usd: number;
  amount_tokens: number;
  detail: string | null;
  created_at: number;
};

export function recordTally(
  db: Database,
  kind: string,
  amountMicro: number,
  detail?: string,
  amountTokens = 0,
): TallyRow {
  const micro = Math.max(0, Math.round(amountMicro));
  const tokens = Math.max(0, Math.round(amountTokens));
  const res = db
    .prepare("INSERT INTO tallies (kind, amount_micro_usd, amount_tokens, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(kind, micro, tokens, detail ?? null, Date.now());
  return {
    id: Number(res.lastInsertRowid),
    kind,
    amount_micro_usd: micro,
    amount_tokens: tokens,
    detail: detail ?? null,
    created_at: Date.now(),
  };
}

export function tallyTotals(db: Database): { kind: string; total_micro_usd: number; total_tokens: number; n: number }[] {
  return db
    .query(
      "SELECT kind, COALESCE(SUM(amount_micro_usd), 0) AS total_micro_usd, COALESCE(SUM(amount_tokens), 0) AS total_tokens, COUNT(*) AS n FROM tallies GROUP BY kind ORDER BY total_micro_usd DESC",
    )
    .all() as { kind: string; total_micro_usd: number; total_tokens: number; n: number }[];
}

export function recentTallies(db: Database, limit = 10): TallyRow[] {
  return db.query("SELECT * FROM tallies ORDER BY created_at DESC LIMIT ?").all(limit) as TallyRow[];
}
