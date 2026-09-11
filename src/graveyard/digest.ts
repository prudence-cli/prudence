// Morning digest (N3): the receipt queue. Spend to the cent, stops with
// reasons, tallies totaled. Pure builder (testable) + CLI printing/saving.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { fmtUsd, listNightJobs, tallyTotals } from "../ledger/db";

const TERMINAL = new Set(["done", "failed", "conflict"]);

function whyLines(workRoot: string | undefined, jobId: string): string {
  if (!workRoot) return "";
  try {
    const text = readFileSync(join(workRoot, jobId, "report.md"), "utf8");
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    return lines.slice(0, 3).join(" ");
  } catch {
    return "";
  }
}

export function buildDigest(db: Database, workRoot?: string): string {
  const jobs = listNightJobs(db).filter((j) => TERMINAL.has(j.status));
  const totals = tallyTotals(db);
  const saved = totals.reduce((s, t) => s + t.total_micro_usd, 0);
  const lines: string[] = [
    `# Pru night digest — ${new Date().toISOString().slice(0, 10)}`,
    "",
    saved > 0
      ? `Pru set aside ${fmtUsd(saved)} on finished nights.`
      : "No savings on the books yet.",
    "",
  ];
  if (jobs.length === 0) {
    lines.push("No finished night jobs. Queue one: pru graveyard \"add tests to src/payments\"");
    return lines.join("\n");
  }
  for (const j of jobs) {
    const est =
      j.est_cost_micro_usd !== null && j.est_cost_micro_usd !== undefined
        ? `${fmtUsd(j.est_cost_micro_usd)} wholesale`
        : "cost unknown";
    const mark = j.status === "done" ? "verified" : "stopped";
    lines.push(`## ${j.status} ${j.id} [${mark}] — ${j.task_prompt}`);
    lines.push(`  Spent about ${est}; model ${j.model}; base ${j.base_sha.slice(0, 8)}.`);
    const why = whyLines(workRoot, j.id);
    if (why) lines.push(`  Why: ${why.slice(0, 300)}`);
    if (j.result_pr_url) lines.push(`  PR: ${j.result_pr_url}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
