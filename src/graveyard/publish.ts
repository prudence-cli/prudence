// Night publish (N3): push the verified branch to the live repo's origin,
// optionally open the PR. Push is local-git (testable); the PR needs `gh`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { getNightJob } from "../ledger/db";

export type PublishResult = {
  pushed: boolean;
  pr_url: string | null;
  note: string;
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  }).trim();
}

export function publishNightJob(
  db: Database,
  jobId: string,
  workRoot: string,
  opts?: { pr?: boolean },
): PublishResult {
  const job = getNightJob(db, jobId);
  if (!job) return { pushed: false, pr_url: null, note: `Pru has no night job ${jobId} on the books.` };
  if (job.status !== "done") {
    return {
      pushed: false,
      pr_url: null,
      note: `Pru will not publish ${jobId}: status is ${job.status}, not done. Only verified branches ship.`,
    };
  }
  const work = join(workRoot, job.id, "work");
  if (!existsSync(join(work, ".git"))) {
    return { pushed: false, pr_url: null, note: `Pru cannot find the night workdir for ${jobId}.` };
  }
  let origin: string;
  try {
    origin = sh(job.project_path, "git", "remote", "get-url", "origin");
  } catch {
    return {
      pushed: false,
      pr_url: null,
      note: `Pru cannot publish ${jobId}: the live repo has no origin remote.`,
    };
  }
  const branch = `night/${job.id}`;
  try {
    try {
      sh(work, "git", "remote", "add", "origin", origin);
    } catch {
      sh(work, "git", "remote", "set-url", "origin", origin);
    }
    sh(work, "git", "push", "-u", "origin", branch);
  } catch (err) {
    return { pushed: false, pr_url: null, note: `Pru could not push ${branch}: ${(err as Error).message}` };
  }
  if (!opts?.pr) {
    return { pushed: true, pr_url: null, note: `Pru pushed ${branch} to origin. Open the PR when ready.` };
  }
  let base = "main";
  try {
    base = sh(job.project_path, "git", "branch", "--show-current") || "main";
  } catch {
    base = "main";
  }
  let body = `Night job ${job.id}: ${job.task_prompt}`;
  try {
    body = readFileSync(join(workRoot, job.id, "report.md"), "utf8");
  } catch {
    // fall back to the one-liner
  }
  try {
    const url = sh(job.project_path, "gh", "pr", "create",
      "--head", branch, "--base", base,
      "--title", `night/${job.id}: ${job.task_prompt.slice(0, 60)}`,
      "--body", body,
    ).split("\n").pop() as string;
    db.prepare("UPDATE night_jobs SET result_pr_url = ? WHERE id = ?").run(url, job.id);
    return { pushed: true, pr_url: url, note: `Pru opened ${url}.` };
  } catch (err) {
    return {
      pushed: true,
      pr_url: null,
      note: `Pru pushed ${branch}, but the PR did not open: ${(err as Error).message}`,
    };
  }
}
