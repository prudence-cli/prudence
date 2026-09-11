// Night runner (N2): queued → submitted → done | conflict | failed.
// Works a frozen bundle clone, never the live repo: the user's checkout is
// untouched until a verified commit exists. Test command runs on base AND
// night branch and the two results are compared (the safety net).

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  fmtUsd,
  listNightJobs,
  updateNightJob,
  type NightJobRow,
} from "../ledger/db";
import { buildDiffPayload, DIFF_MAX_OUTPUT_TOKENS } from "./diff_builder";
import { extractDiffForJob, type BatchClient } from "./batch_client";
import { readTextFiles } from "./snapshot";

export type RunOpts = {
  workRoot: string;
  testCommand: string;
  client: BatchClient;
};

export type JobReport = {
  job_id: string;
  status: string;
  markdown: string;
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  }).trim();
}

function shPass(cwd: string, command: string): { pass: boolean; output: string } {
  try {
    const out = execFileSync("sh", ["-c", command], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    return { pass: true, output: String(out).slice(-2000) };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown };
    const output = String(e.stdout ?? e.stderr ?? err).slice(-2000);
    return { pass: false, output };
  }
}

function jobDir(workRoot: string, jobId: string): string {
  const dir = join(workRoot, jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cloneBundle(bundlePath: string, dest: string, baseSha: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  sh(dest, "git", "clone", "-q", bundlePath, ".");
  sh(dest, "git", "checkout", "-q", baseSha);
}

async function submitJob(db: Database, job: NightJobRow, opts: RunOpts): Promise<void> {
  const tmp = join(tmpdir(), `pru-n2-submit-${job.id}`);
  try {
    cloneBundle(job.repo_snapshot, tmp, job.base_sha);
    const { files, truncated } = readTextFiles(tmp);
    if (files.length === 0) {
      updateNightJob(db, job.id, { status: "failed", finished_at: Date.now() });
      return;
    }
    const payload = buildDiffPayload(
      {
        project_path: job.project_path,
        base_sha: job.base_sha,
        bundle_path: job.repo_snapshot,
        files,
        total_chars: 0,
        tokens_est: 0,
        truncated,
      },
      job.task_prompt,
      job.model,
    );
    const { batch_id } = await opts.client.submit(job.id, {
      model: payload.model,
      max_tokens: DIFF_MAX_OUTPUT_TOKENS,
      system: payload.system,
      messages: [{ role: "user", content: payload.user }],
    });
    updateNightJob(db, job.id, { status: "submitted", batch_id });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function finish(db: Database, job: NightJobRow, dir: string, status: string, markdown: string): JobReport {
  writeFileSync(join(dir, "report.md"), markdown + "\n");
  updateNightJob(db, job.id, { status, finished_at: Date.now() });
  return { job_id: job.id, status, markdown };
}

async function settleJob(db: Database, job: NightJobRow, opts: RunOpts): Promise<JobReport> {
  const dir = jobDir(opts.workRoot, job.id);
  const work = join(dir, "work");
  if (!job.batch_id) {
    return finish(db, job, dir, "failed", `# Night job ${job.id} — failed\n\nNo batch id on the books.`);
  }
  const polled = await opts.client.poll(job.batch_id);
  if (polled.state !== "ended") return { job_id: job.id, status: "submitted", markdown: "" };
  const diff = extractDiffForJob(polled.results_text, job.id);
  if (diff === null || !diff.trim()) {
    return finish(
      db, job, dir, "failed",
      `# Night job ${job.id} — failed\n\nTask: ${job.task_prompt}\n\nThe batch result was unusable (no single diff for this job). Nothing applied, nothing committed.`,
    );
  }
  writeFileSync(join(dir, "result.diff"), diff);

  cloneBundle(job.repo_snapshot, work, job.base_sha);
  try {
    sh(work, "git", "apply", "--check", join(dir, "result.diff"));
  } catch {
    return finish(
      db, job, dir, "conflict",
      `# Night job ${job.id} — conflict\n\nTask: ${job.task_prompt}\n\nThe night diff does not apply to ${job.base_sha.slice(0, 8)} (` +
        `\`git apply --check\` failed). The raw diff is kept at \`result.diff\`; nothing committed.`,
    );
  }

  // Safety net: the same command on base AND on the night branch.
  const base = shPass(work, opts.testCommand);
  const branch = `night/${job.id}`;
  sh(work, "git", "checkout", "-qb", branch);
  try {
    sh(work, "git", "apply", join(dir, "result.diff"));
  } catch {
    return finish(
      db, job, dir, "conflict",
      `# Night job ${job.id} — conflict\n\nTask: ${job.task_prompt}\n\nThe diff passed \`--check\` but failed to apply. Raw diff kept at \`result.diff\`; nothing committed.`,
    );
  }
  const night = shPass(work, opts.testCommand);

  const verdictLine =
    `Base tests: ${base.pass ? "PASS" : "FAIL"} | Night tests: ${night.pass ? "PASS" : "FAIL"}`;
  if (!night.pass) {
    return finish(
      db, job, dir, "failed",
      `# Night job ${job.id} — failed\n\nTask: ${job.task_prompt}\n\n${verdictLine} — ` +
        `the night branch did not pass, so nothing was committed. Workdir kept for inspection.`,
    );
  }
  sh(work, "git", "add", "-A");
  sh(work, "git", "-c", "user.email=pru@local", "-c", "user.name=Pru", "commit", "-qm", `night/${job.id}: ${job.task_prompt}`);
  const commit = sh(work, "git", "rev-parse", "HEAD");
  const estLine =
    job.est_cost_micro_usd !== null && job.est_cost_micro_usd !== undefined
      ? `Est batched cost: ${fmtUsd(job.est_cost_micro_usd)}. Real cost posts at 50% on the invoice.`
      : "Cost estimate unknown (unpriced model at queue time).";
  return finish(
    db, job, dir, "done",
    `# Night job ${job.id} — done\n\nTask: ${job.task_prompt}\n\n` +
      `Base: ${job.base_sha.slice(0, 8)} | Branch: ${branch} | Commit: ${commit.slice(0, 8)}\n\n` +
      `${verdictLine} — ${base.pass ? "no regression" : "an improvement"}, committed.\n\n${estLine}`,
  );
}

// Process the queue: submit everything due, then settle everything
// submitted. Returns one report per job that reached a terminal state
// (plus silent entries for jobs still in flight).
export async function runDueJobs(db: Database, opts: RunOpts): Promise<JobReport[]> {
  const reports: JobReport[] = [];
  mkdirSync(opts.workRoot, { recursive: true });
  for (const job of listNightJobs(db, "queued")) {
    await submitJob(db, job, opts);
  }
  for (const job of listNightJobs(db, "submitted")) {
    const report = await settleJob(db, job, opts);
    if (report.markdown) reports.push(report);
  }
  return reports;
}
