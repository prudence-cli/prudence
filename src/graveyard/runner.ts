// Night runner (N2): queued → submitted → done | conflict | failed.
// Works a frozen bundle clone, never the live repo: the user's checkout is
// untouched until a verified commit exists. Test command runs on base AND
// night branch and the two results are compared (the safety net).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  fmtUsd,
  getNightJob,
  listNightJobs,
  recordTally,
  updateNightJob,
  type NightJobRow,
} from "../ledger/db";
import { buildDiffPayload, DIFF_MAX_OUTPUT_TOKENS, estimateNightJob, sanitizeDiff } from "./diff_builder";
import { extractDiffForJob, type BatchClient } from "./batch_client";
import { readTextFiles, snapshotRepo } from "./snapshot";

export type RunOpts = {
  workRoot: string;
  testCommand: string;
  client: BatchClient;
  // Install step, injectable for offline tests. Default shells out to the
  // running Bun (absolute path — launchd PATH is a wasteland).
  install?: (workdir: string) => { pass: boolean; output: string };
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
      env: sanePathEnv(),
    });
    return { pass: true, output: String(out).slice(-2000) };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown };
    const output = String(e.stdout ?? e.stderr ?? err).slice(-2000);
    return { pass: false, output };
  }
}

// Launchd children inherit a wasteland PATH (no bun, no npm shims). The
// night must not depend on interactive shell dotfiles to find its tools.
function sanePathEnv(): Record<string, string> {
  const home = process.env.HOME ?? "";
  const extra = [`${home}/.bun/bin`, `${home}/.local/bin`, "/usr/local/bin", "/opt/homebrew/bin"];
  return { ...(process.env as Record<string, string>), PATH: [...extra, process.env.PATH ?? ""].join(":") };
}

function jobDir(workRoot: string, jobId: string): string {
  const dir = join(workRoot, jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A missing trailing newline is exit-128 corruption to git-apply, never
// meaning. Normalize in place so the kept artifact is exactly what passed.
export function normalizeDiffFile(diffPath: string): void {
  const text = readFileSync(diffPath, "utf8");
  if (!text.endsWith("\n")) writeFileSync(diffPath, text + "\n");
}

function cloneBundle(bundlePath: string, dest: string, baseSha: string): void {

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  sh(dest, "git", "clone", "-q", bundlePath, ".");
  sh(dest, "git", "checkout", "-q", baseSha);
}

// Night workdirs are clean bundle clones: no node_modules by design, so
// the safety net would judge every diff against a broken tree. Install
// first; a failed install fails the job with its output on record.
export function installWorkdirDeps(workdir: string): { pass: boolean; output: string } {
  try {
    const out = execFileSync(process.execPath, ["install", "--cwd", workdir], {
      cwd: workdir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
      env: sanePathEnv(),
    });
    return { pass: true, output: String(out).slice(-2000) };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown };
    return { pass: false, output: String(e.stdout ?? e.stderr ?? err).slice(-2000) };
  }
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
  writeFileSync(join(dir, "result-raw.diff"), diff);
  const clean = sanitizeDiff(diff);
  writeFileSync(join(dir, "result.diff"), clean);

  cloneBundle(job.repo_snapshot, work, job.base_sha);
  // A missing trailing newline is exit-128 corruption to git-apply, never
  // meaning. Normalize the artifact itself so what we judge is what we keep.
  normalizeDiffFile(join(dir, "result.diff"));
  try {
    sh(work, "git", "apply", "--check", join(dir, "result.diff"));
  } catch {
    return finish(
      db, job, dir, "conflict",
      `# Night job ${job.id} — conflict\n\nTask: ${job.task_prompt}\n\nThe night diff does not apply to ${job.base_sha.slice(0, 8)} (` +
        `\`git apply --check\` failed). The model output is kept at \`result-raw.diff\`, sanitized attempt at \`result.diff\`; nothing committed.`,
    );
  }

  // Dependencies first: the clone carries no node_modules by design.
  const install = (opts.install ?? installWorkdirDeps)(work);
  if (!install.pass) {
    return finish(
      db, job, dir, "failed",
      `# Night job ${job.id} — failed\n\nTask: ${job.task_prompt}\n\nDependencies would not install, so the tests could prove nothing. Nothing committed.\n\n<details>\n<summary>install output</summary>\n\n\`\`\`\n${install.output}\n\`\`\`\n</details>`,
    );
  }

  // Safety net: the same command on base AND on the night branch. Tails
  // ship in the report — a verdict without evidence is a rumor.
  const base = shPass(work, opts.testCommand);
  const branch = `night/${job.id}`;
  sh(work, "git", "checkout", "-qb", branch);
  try {
    sh(work, "git", "apply", join(dir, "result.diff"));
  } catch {
    return finish(
      db, job, dir, "conflict",
      `# Night job ${job.id} — conflict\n\nTask: ${job.task_prompt}\n\nThe diff passed \`--check\` but failed to apply. Model output kept at \`result-raw.diff\`; nothing committed.`,
    );
  }
  const night = shPass(work, opts.testCommand);

  const verdictLine =
    `Base tests: ${base.pass ? "PASS" : "FAIL"} | Night tests: ${night.pass ? "PASS" : "FAIL"}`;
  if (!night.pass) {
    return finish(
      db, job, dir, "failed",
      `# Night job ${job.id} — failed\n\nTask: ${job.task_prompt}\n\n${verdictLine} — ` +
        `the night branch did not pass, so nothing was committed. Workdir kept for inspection.\n\n<details>\n<summary>base output</summary>\n\n\`\`\`\n${base.output}\n\`\`\`\n</details>\n\n<details>\n<summary>night output</summary>\n\n\`\`\`\n${night.output}\n\`\`\`\n</details>`,
    );
  }
  sh(work, "git", "add", "-A");
  sh(work, "git", "-c", "user.email=pru@local", "-c", "user.name=Pru", "commit", "-qm", `night/${job.id}: ${job.task_prompt}`);
  const commit = sh(work, "git", "rev-parse", "HEAD");
  // The discount is realized at commit time: wholesale, not retail.
  if (
    job.est_standard_micro_usd !== null &&
    job.est_standard_micro_usd !== undefined &&
    job.est_cost_micro_usd !== null &&
    job.est_cost_micro_usd !== undefined
  ) {
    recordTally(
      db,
      "night_discount",
      job.est_standard_micro_usd - job.est_cost_micro_usd,
      `${job.id}: batched wholesale instead of retail`,
    );
  }
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

// Retry a failed/conflict job against the live repo as it stands now:
// fresh snapshot, fresh estimate, back to queued. The old bundle is
// removed once the new one exists.
export function retryNightJob(db: Database, jobId: string): NightJobRow {
  const job = getNightJob(db, jobId);
  if (!job) throw new Error(`Pru has no night job ${jobId} on the books.`);
  if (job.status !== "failed" && job.status !== "conflict") {
    throw new Error(`Pru only retries failed or conflicted jobs (status is ${job.status}).`);
  }
  const snap = snapshotRepo(job.project_path);
  const payload = buildDiffPayload(
    {
      project_path: snap.project_path,
      base_sha: snap.base_sha,
      bundle_path: snap.bundle_path,
      files: snap.files,
      total_chars: snap.total_chars,
      tokens_est: snap.tokens_est,
      truncated: snap.truncated,
    },
    job.task_prompt,
    job.model,
  );
  const est = estimateNightJob(payload);
  if (!est) throw new Error(`Pru cannot price model "${job.model}" — refusing to queue a guess.`);
  if (job.repo_snapshot !== snap.bundle_path) {
    rmSync(job.repo_snapshot, { force: true });
  }
  updateNightJob(db, jobId, {
    status: "queued",
    batch_id: null,
    repo_snapshot: snap.bundle_path,
    base_sha: snap.base_sha,
    est_cost_micro_usd: est.batch_micro_usd,
    est_standard_micro_usd: est.standard_micro_usd,
    real_cost_micro_usd: null,
    result_pr_url: null,
    finished_at: null,
  });
  const next = getNightJob(db, jobId);
  if (!next) throw new Error(`Pru lost night job ${jobId} while requeueing.`);
  return next;
}
