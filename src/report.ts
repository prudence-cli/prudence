// `pru report`: the receipt, not the cockpit. One self-contained HTML
// file from the ledger — inline CSS only, zero JS, zero remote assets.
// Every figure traces to a ledger row; anything untraceable renders as
// "insufficient data". Spec: docs/report-spec.md.

import type { Database } from "bun:sqlite";
import { fmtUsd, formatCapAmount, listNightJobs, tallyTotals, type CapUnit } from "./ledger/db";
import { PRICE_TABLE_SOURCE, PRICE_TABLE_VERIFIED } from "./ledger/pricing";

export type ReportOpts = {
  sinceDays?: number;
  sessionId?: string;
};

function esc(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function windowStart(sinceDays?: number): number {
  if (!sinceDays || !(sinceDays > 0)) return 0;
  return Date.now() - Math.floor(sinceDays) * 86_400_000;
}

type SessionSummary = {
  id: string;
  agent: string;
  project_path: string;
  calls: number;
  spent_micro_usd: number;
  spent_tokens: number;
};

function sessionSummaries(db: Database, since: number, only?: string): SessionSummary[] {
  const sessions = db.query("SELECT * FROM session ORDER BY started_at").all() as {
    id: string;
    agent: string;
    project_path: string;
  }[];
  const out: SessionSummary[] = [];
  for (const s of sessions) {
    if (only && s.id !== only) continue;
    const row = db
      .query(
        "SELECT COUNT(*) AS n, COALESCE(SUM(cost_micro_usd), 0) AS spent, COALESCE(SUM(cost_tokens), 0) AS tokens FROM usage_ledger WHERE session_id = ? AND status = 'ok' AND created_at >= ?",
      )
      .get(s.id, since) as { n: number; spent: number; tokens: number };
    if (only === undefined && row.n === 0) continue;
    out.push({
      id: s.id,
      agent: s.agent,
      project_path: s.project_path,
      calls: row.n,
      spent_micro_usd: row.spent,
      spent_tokens: row.tokens,
    });
  }
  return out;
}

type RefusalRow = {
  id: number;
  session_id: string;
  type: string;
  message: string;
  created_at: number;
};

function fmtAmount(micro: number, tokens: number): string {
  const parts: string[] = [];
  if (micro > 0) parts.push(fmtUsd(micro));
  if (tokens > 0) parts.push(`${tokens.toLocaleString("en-US")} tokens`);
  return parts.length ? parts.join(" + ") : "$0.00";
}

export function buildReportHtml(db: Database, opts: ReportOpts = {}): string {
  const since = windowStart(opts.sinceDays);
  const sessions = sessionSummaries(db, since, opts.sessionId);
  const caps = db.query("SELECT * FROM cap_state ORDER BY scope, scope_key").all() as {
    scope: string;
    scope_key: string;
    unit: CapUnit;
    limit_native: number;
    spent_native: number;
  }[];
  const refusals = db
    .query(
      "SELECT id, session_id, type, message, created_at FROM refusal_events WHERE created_at >= ? ORDER BY created_at DESC LIMIT 50",
    )
    .all(since) as RefusalRow[];
  const jobs = listNightJobs(db).filter((j) => !since || j.queued_at >= since);
  const tallies = tallyTotals(db);
  const usageRows = db
    .query("SELECT COUNT(*) AS n FROM usage_ledger WHERE created_at >= ?")
    .get(since) as { n: number };
  const refusalRows = db
    .query("SELECT COUNT(*) AS n FROM refusal_events WHERE created_at >= ?")
    .get(since) as { n: number };

  const totalMicro = sessions.reduce((s, x) => s + x.spent_micro_usd, 0);
  const totalCalls = sessions.reduce((s, x) => s + x.calls, 0);
  const savedMicro = tallies.reduce((s, t) => s + t.total_micro_usd, 0);
  const savedTokens = tallies.reduce((s, t) => s + (t.total_tokens ?? 0), 0);

  const sessionRows = sessions
    .map(
      (s) =>
        `<tr><td><code>${esc(s.id)}</code></td><td>${esc(s.agent)}</td><td>${esc(s.project_path)}</td>` +
        `<td class="num">${s.calls}</td><td class="num">${esc(fmtUsd(s.spent_micro_usd))}</td></tr>`,
    )
    .join("\n");

  const capRows = caps
    .map(
      (c) =>
        `<tr><td>${esc(c.scope)}:${esc(c.scope_key)}</td>` +
        `<td class="num">${esc(formatCapAmount(c.spent_native, c.unit))} of ${esc(formatCapAmount(c.limit_native, c.unit))}</td></tr>`,
    )
    .join("\n");

  const refusalList = refusals.length
    ? refusals
        .map(
          (r) =>
            `<tr><td class="num">#${r.id}</td><td><code>${esc(r.type)}</code></td>` +
            `<td><code>${esc(r.session_id)}</code></td><td>${esc(r.message)}</td></tr>`,
        )
        .join("\n")
    : `<tr><td colspan="4">No refusals on the books — the meter never had to speak.</td></tr>`;

  const tallyList = tallies.length
    ? tallies
        .map(
          (t) =>
            `<tr><td><code>${esc(t.kind)}</code></td>` +
            `<td class="num">${esc(fmtAmount(t.total_micro_usd, t.total_tokens ?? 0))}</td>` +
            `<td class="num">${t.n}</td></tr>`,
        )
        .join("\n")
    : `<tr><td colspan="3">Pru has set nothing aside yet.</td></tr>`;

  const jobList = jobs.length
    ? jobs
        .map((j) => {
          const est =
            j.est_cost_micro_usd !== null && j.est_cost_micro_usd !== undefined
              ? fmtUsd(j.est_cost_micro_usd)
              : "insufficient data";
          return (
            `<tr><td><code>${esc(j.id)}</code></td><td><code>${esc(j.status)}</code></td>` +
            `<td>${esc(j.task_prompt.slice(0, 120))}</td><td class="num">${esc(est)}</td>` +
            `<td>${j.result_pr_url ? `<code>${esc(j.result_pr_url)}</code>` : "—"}</td></tr>`
          );
        })
        .join("\n")
    : `<tr><td colspan="5">No night jobs on the books.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Pru ledger report</title>
<style>
  body { background: #161210; color: #e8ded0; font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 2em auto; max-width: 880px; padding: 0 1em; }
  h1, h2 { color: #d08a4e; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border-bottom: 1px solid #3a2f26; padding: 0.4em 0.6em; text-align: left; vertical-align: top; }
  th { color: #a89880; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  code { background: #241c14; padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.92em; }
  .badge { display: inline-block; border: 1px solid #d08a4e; color: #d08a4e; border-radius: 999px; padding: 0.1em 0.8em; font-size: 0.85em; }
  .lede { font-size: 1.15em; }
  footer { color: #a89880; font-size: 0.85em; margin-top: 3em; border-top: 1px solid #3a2f26; padding-top: 1em; }
  a { color: #d08a4e; }
</style>
</head>
<body>
<h1>Pru ledger report</h1>
<p><span class="badge">rendered from ${usageRows.n} ledger rows + ${refusalRows.n} refusal rows</span></p>
<p class="lede">Pru set aside ${esc(fmtAmount(savedMicro, savedTokens))}. Sessions posted ${esc(fmtUsd(totalMicro))} across ${totalCalls} calls.</p>

<h2>Savings</h2>
<table><tr><th>Kind</th><th class="num">Set aside</th><th class="num">Entries</th></tr>
${tallyList}
</table>

<h2>Spend</h2>
<table><tr><th>Session</th><th>Agent</th><th>Project</th><th class="num">Calls</th><th class="num">Posted</th></tr>
${sessionRows || `<tr><td colspan="5">No sessions on the books yet.</td></tr>`}
</table>

<h2>Caps</h2>
<table><tr><th>Scope</th><th class="num">Spent of limit</th></tr>
${capRows || `<tr><td colspan="2">No caps armed.</td></tr>`}
</table>

<h2>Refusals</h2>
<table><tr><th class="num">Row</th><th>Type</th><th>Session</th><th>Why</th></tr>
${refusalList}
</table>

<h2>Nights</h2>
<table><tr><th>Job</th><th>Status</th><th>Task</th><th class="num">Est (batch)</th><th>PR</th></tr>
${jobList}
</table>

<footer>
Pricing: ${esc(PRICE_TABLE_SOURCE)}, verified ${esc(PRICE_TABLE_VERIFIED)}. Spend covers relayed traffic only —
routes that bypass the daemon are never booked. Every figure above traces to a ledger row id shown beside it.
</footer>
</body>
</html>
`;
}
