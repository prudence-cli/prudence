// N1 acceptance: real repo → valid batch payload, dry-run queue.
// Repos are throwaway tmp dirs. No network, no Batch API submission (N2).

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotRepo, SNAPSHOT_MAX_CHARS } from "../src/graveyard/snapshot";
import { buildDiffPayload, DIFF_MAX_OUTPUT_TOKENS, estimateNightJob } from "../src/graveyard/diff_builder";
import { MockBatchClient, extractDiffForJob } from "../src/graveyard/batch_client";
import { runDueJobs } from "../src/graveyard/runner";
import { publishNightJob } from "../src/graveyard/publish";
import { agentLabel, graveyardPlist, scheduleGraveyard, unscheduleGraveyard } from "../src/graveyard/schedule";
import { buildDigest } from "../src/graveyard/digest";
import { listNightJobs, openLedger, queueNightJob, tallyTotals } from "../src/ledger/db";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pru-n1-"));
  git(dir, "init", "-q");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "config", "user.email", "t@t");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "config", "user.name", "t");
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture");
  return dir;
}

const cleanup = (dir: string) => rmSync(dir, { recursive: true, force: true });

describe("snapshotter", () => {
  test("freezes base sha, bundle, and text files", () => {
    const dir = makeRepo({
      "src/a.ts": "export const a = 1;\n",
      "README.md": "# demo\n",
    });
    try {
      const snap = snapshotRepo(dir);
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      expect(snap.base_sha).toBe(sha);
      expect(snap.files.map((f) => f.path).sort()).toEqual(["README.md", "src/a.ts"]);
      expect(snap.truncated).toBe(false);
      expect(snap.tokens_est).toBeGreaterThan(0);
      const listed = execFileSync("git", ["bundle", "verify", snap.bundle_path, "HEAD"], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(listed).toContain("records a complete history");
      rmSync(snap.bundle_path, { force: true });
    } finally {
      cleanup(dir);
    }
  });

  test("skips binaries and enforces the context cap", () => {
    const dir = makeRepo({
      "src/ok.ts": "export const ok = true;\n",
      "assets/blob.bin": Buffer.from([0, 1, 2, 3, 4]).toString("binary"),
      "logs/huge.log": "x".repeat(SNAPSHOT_MAX_CHARS),
    });
    try {
      const snap = snapshotRepo(dir);
      expect(snap.files.some((f) => f.path === "assets/blob.bin")).toBe(false);
      expect(snap.truncated).toBe(true);
      expect(snap.total_chars).toBeLessThanOrEqual(SNAPSHOT_MAX_CHARS);
      rmSync(snap.bundle_path, { force: true });
    } finally {
      cleanup(dir);
    }
  });

  test("non-git directory fails cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "pru-n1-nogit-"));
    try {
      expect(() => snapshotRepo(dir)).toThrow(/git repo/);
    } finally {
      cleanup(dir);
    }
  });
});

describe("diff builder + 50% math", () => {
  test("payload is a valid diff-only request carrying the snapshot", () => {
    const dir = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      const snap = snapshotRepo(dir);
      const payload = buildDiffPayload(snap, "Add tests for a.", "claude-sonnet-4-5");
      expect(payload.model).toBe("claude-sonnet-4-5");
      expect(payload.system).toContain("ONLY");
      expect(payload.user).toContain("Add tests for a.");
      expect(payload.user).toContain("export const a = 1;");
      expect(payload.user).toContain(snap.base_sha);
      expect(payload.max_output_tokens).toBe(DIFF_MAX_OUTPUT_TOKENS);
      rmSync(snap.bundle_path, { force: true });
    } finally {
      cleanup(dir);
    }
  });

  test("batch estimate is half the standard price", () => {
    const dir = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      const snap = snapshotRepo(dir);
      const payload = buildDiffPayload(snap, "Add tests.", "claude-sonnet-4-5");
      const est = estimateNightJob(payload)!;
      expect(est).not.toBeNull();
      expect(Number.isInteger(est.batch_micro_usd)).toBe(true);
      // Exact halving up to 1 micro of per-component rounding.
      expect(Math.abs(est.batch_micro_usd * 2 - est.standard_micro_usd)).toBeLessThanOrEqual(2);
      expect(est.saved_micro_usd).toBe(est.standard_micro_usd - est.batch_micro_usd);
      expect(est.saved_micro_usd).toBeGreaterThan(0);
      rmSync(snap.bundle_path, { force: true });
    } finally {
      cleanup(dir);
    }
  });

  test("unpriced model refuses to queue a guess", () => {
    const dir = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      const snap = snapshotRepo(dir);
      const payload = buildDiffPayload(snap, "Add tests.", "mystery-9000");
      expect(estimateNightJob(payload)).toBeNull();
      rmSync(snap.bundle_path, { force: true });
    } finally {
      cleanup(dir);
    }
  });
});

describe("dry-run queue", () => {
  test("job lands queued with its estimate; list reads it back", () => {
    const db = openLedger(":memory:");
    const dir = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      const snap = snapshotRepo(dir);
      const payload = buildDiffPayload(snap, "Add tests.", "claude-sonnet-4-5");
      const est = estimateNightJob(payload)!;
      const job = queueNightJob(db, {
        projectPath: snap.project_path,
        repoSnapshot: snap.bundle_path,
        baseSha: snap.base_sha,
        taskPrompt: "Add tests.",
        model: "claude-sonnet-4-5",
        estCostMicro: est.batch_micro_usd,
      });
      expect(job.status).toBe("queued");
      expect(job.batch_id).toBeNull();
      const jobs = listNightJobs(db, "queued");
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(job.id);
      expect(jobs[0].est_cost_micro_usd).toBe(est.batch_micro_usd);
      rmSync(snap.bundle_path, { force: true });
    } finally {
      cleanup(dir);
    }
    db.close();
  });
});

const FIX_DIFF = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-export const a = 1;
+export const a = 2;
`;
const BROKEN_DIFF = `--- a/src/nope.ts
+++ b/src/nope.ts
@@ -1 +1 @@
-missing context line that never matched anything here
+replacement
`;

// Queue one job for dir, then work it with a scripted mock batch.
async function workOneJob(
  dir: string,
  task: string,
  cannedDiff: string,
  testCommand: string,
  workRoot: string,
) {
  const db = openLedger(":memory:");
  const snap = snapshotRepo(dir);
  const payload = buildDiffPayload(snap, task, "claude-sonnet-4-5");
  const est = estimateNightJob(payload)!;
  const job = queueNightJob(db, {
    projectPath: snap.project_path,
    repoSnapshot: snap.bundle_path,
    baseSha: snap.base_sha,
    taskPrompt: task,
    model: "claude-sonnet-4-5",
    estCostMicro: est.batch_micro_usd,
    estStandardMicro: est.standard_micro_usd,
  });
  const reports = await runDueJobs(db, {
    workRoot,
    testCommand,
    client: new MockBatchClient(cannedDiff),
  });
  const rows = listNightJobs(db);
  db.close();
  return { job, reports, rows, bundle: snap.bundle_path };
}

function mkWorkRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pru-n2-work-"));
  return dir;
}

describe("night runner (mock batch)", () => {
  test("improvement: base fails, branch passes, committed with report", async () => {
    const dir = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const workRoot = mkWorkRoot();
    try {
      const { job, reports, rows, bundle } = await workOneJob(
        dir, "Bump a.", FIX_DIFF, 'grep -q "a = 2" src/a.ts', workRoot,
      );
      expect(rows[0].status).toBe("done");
      expect(reports).toHaveLength(1);
      expect(reports[0].markdown).toContain("Base tests: FAIL | Night tests: PASS");
      expect(reports[0].markdown).toContain("improvement");
      // Commit exists in the night workdir; the live repo is untouched.
      const log = execFileSync("git", ["log", "--oneline", `night/${job.id}`], {
        cwd: join(workRoot, job.id, "work"),
        encoding: "utf8",
      });
      expect(log).toContain(`night/${job.id}`);
      const branches = execFileSync("git", ["branch", "--list", "night/*"], {
        cwd: dir,
        encoding: "utf8",
      }).trim();
      expect(branches).toBe("");
      rmSync(bundle, { force: true });
    } finally {
      cleanup(dir);
      cleanup(workRoot);
    }
  });

  test("no regression: green stays green, committed", async () => {
    const dir = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const workRoot = mkWorkRoot();
    try {
      const { rows, reports, bundle } = await workOneJob(dir, "Bump a.", FIX_DIFF, "true", workRoot);
      expect(rows[0].status).toBe("done");
      expect(reports[0].markdown).toContain("Base tests: PASS | Night tests: PASS");
      expect(reports[0].markdown).toContain("no regression");
      rmSync(bundle, { force: true });
    } finally {
      cleanup(dir);
      cleanup(workRoot);
    }
  });

  test("regression: branch fails, nothing committed", async () => {
    const dir = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const workRoot = mkWorkRoot();
    try {
      const { job, rows, reports, bundle } = await workOneJob(
        dir, "Bump a.", FIX_DIFF, 'grep -q "a = 1" src/a.ts', workRoot,
      );
      expect(rows[0].status).toBe("failed");
      expect(reports[0].markdown).toContain("Base tests: PASS | Night tests: FAIL");
      const count = execFileSync("git", ["rev-list", "--count", "HEAD"], {
        cwd: join(workRoot, job.id, "work"),
        encoding: "utf8",
      }).trim();
      expect(count).toBe("1");
      rmSync(bundle, { force: true });
    } finally {
      cleanup(dir);
      cleanup(workRoot);
    }
  });

  test("conflict: unappliable diff kept as artifact, nothing committed", async () => {
    const dir = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const workRoot = mkWorkRoot();
    try {
      const { job, rows, reports, bundle } = await workOneJob(
        dir, "Bump a.", BROKEN_DIFF, "true", workRoot,
      );
      expect(rows[0].status).toBe("conflict");
      expect(reports[0].markdown).toContain("conflict");
      const fs = await import("node:fs");
      expect(fs.existsSync(join(workRoot, job.id, "result.diff"))).toBe(true);
      rmSync(bundle, { force: true });
    } finally {
      cleanup(dir);
      cleanup(workRoot);
    }
  });

  test("unusable batch result fails without touching the tree", async () => {
    const dir = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const workRoot = mkWorkRoot();
    try {
      const { rows, reports, bundle } = await workOneJob(dir, "Bump a.", "", "true", workRoot);
      expect(rows[0].status).toBe("failed");
      expect(reports[0].markdown).toContain("unusable");
      rmSync(bundle, { force: true });
    } finally {
      cleanup(dir);
      cleanup(workRoot);
    }
  });
});

describe("result JSONL extraction", () => {
  test("strict: one job, one text block, or null", () => {
    const good = JSON.stringify({
      custom_id: "nj_1",
      result: { type: "succeeded", message: { content: [{ type: "text", text: "diff-here" }] } },
    });
    const other = JSON.stringify({
      custom_id: "nj_2",
      result: { type: "succeeded", message: { content: [{ type: "text", text: "nope" }] } },
    });
    expect(extractDiffForJob(`${other}\n${good}`, "nj_1")).toBe("diff-here");
    expect(extractDiffForJob("not json", "nj_1")).toBeNull();
    expect(extractDiffForJob(good, "nj_missing")).toBeNull();
    const failed = JSON.stringify({ custom_id: "nj_1", result: { type: "errored" } });
    expect(extractDiffForJob(failed, "nj_1")).toBeNull();
  });
});

describe("tallies (savings ledger)", () => {
  test("a finished night books its wholesale discount", async () => {
    const dir = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const workRoot = mkWorkRoot();
    try {
      const db = openLedger(":memory:");
      const snap = snapshotRepo(dir);
      const payload = buildDiffPayload(snap, "Bump a.", "claude-sonnet-4-5");
      const est = estimateNightJob(payload)!;
      const job = queueNightJob(db, {
        projectPath: snap.project_path,
        repoSnapshot: snap.bundle_path,
        baseSha: snap.base_sha,
        taskPrompt: "Bump a.",
        model: "claude-sonnet-4-5",
        estCostMicro: est.batch_micro_usd,
        estStandardMicro: est.standard_micro_usd,
      });
      await runDueJobs(db, { workRoot, testCommand: "true", client: new MockBatchClient(FIX_DIFF) });
      const tallies = db.query("SELECT * FROM tallies").all() as Record<string, unknown>[];
      expect(tallies).toHaveLength(1);
      expect(tallies[0].kind).toBe("night_discount");
      expect(tallies[0].amount_micro_usd).toBe(est.standard_micro_usd - est.batch_micro_usd);
      expect(String(tallies[0].detail)).toContain(job.id);
      const totals = tallyTotals(db);
      expect(totals[0].total_micro_usd).toBe(est.standard_micro_usd - est.batch_micro_usd);
      db.close();
      rmSync(snap.bundle_path, { force: true });
    } finally {
      cleanup(dir);
      cleanup(workRoot);
    }
  });

  test("a failed night books no discount", async () => {
    const dir = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const workRoot = mkWorkRoot();
    try {
      const db = openLedger(":memory:");
      const snap = snapshotRepo(dir);
      const payload = buildDiffPayload(snap, "Bump a.", "claude-sonnet-4-5");
      const est = estimateNightJob(payload)!;
      queueNightJob(db, {
        projectPath: snap.project_path,
        repoSnapshot: snap.bundle_path,
        baseSha: snap.base_sha,
        taskPrompt: "Bump a.",
        model: "claude-sonnet-4-5",
        estCostMicro: est.batch_micro_usd,
        estStandardMicro: est.standard_micro_usd,
      });
      await runDueJobs(db, {
        workRoot,
        testCommand: 'grep -q "a = 1" src/a.ts',
        client: new MockBatchClient(FIX_DIFF),
      });
      expect(listNightJobs(db)[0].status).toBe("failed");
      expect(db.query("SELECT * FROM tallies").all()).toHaveLength(0);
      db.close();
      rmSync(snap.bundle_path, { force: true });
    } finally {
      cleanup(dir);
      cleanup(workRoot);
    }
  });
});

describe("publish (local push)", () => {
  test("verified branch pushes to origin; unverified refuses", async () => {
    const dir = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const bare = mkdtempSync(join(tmpdir(), "pru-n3-bare-"));
    const workRoot = mkWorkRoot();
    try {
      execFileSync("git", ["init", "--bare", "-q", bare]);
      execFileSync("git", ["-C", dir, "remote", "add", "origin", bare]);
      const db = openLedger(":memory:");
      const snap = snapshotRepo(dir);
      const payload = buildDiffPayload(snap, "Bump a.", "claude-sonnet-4-5");
      const est = estimateNightJob(payload)!;
      const queue = (task: string) =>
        queueNightJob(db, {
          projectPath: snap.project_path,
          repoSnapshot: snap.bundle_path,
          baseSha: snap.base_sha,
          taskPrompt: task,
          model: "claude-sonnet-4-5",
          estCostMicro: est.batch_micro_usd,
          estStandardMicro: est.standard_micro_usd,
        });
      const good = queue("Bump a.");
      const early = queue("Too soon.");
      await runDueJobs(db, { workRoot, testCommand: "true", client: new MockBatchClient(FIX_DIFF) });
      // Second job also ran (same mock fixes the same file) — force it back
      // to queued to prove the unverified refusal path.
      db.prepare("UPDATE night_jobs SET status = 'queued' WHERE id = ?").run(early.id);
      const ok = publishNightJob(db, good.id, workRoot);
      expect(ok.pushed).toBe(true);
      const refs = execFileSync("git", ["ls-remote", bare, `night/${good.id}`], {
        encoding: "utf8",
      }).trim();
      expect(refs).toContain(`night/${good.id}`);
      const no = publishNightJob(db, early.id, workRoot);
      expect(no.pushed).toBe(false);
      expect(no.note).toContain("not done");
      db.close();
      rmSync(snap.bundle_path, { force: true });
    } finally {
      cleanup(dir);
      cleanup(bare);
      cleanup(workRoot);
    }
  });
});

describe("digest (receipt queue)", () => {
  test("spend to the cent, stops with reasons, verified marks", async () => {
    const dir = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const workRoot = mkWorkRoot();
    try {
      const db = openLedger(":memory:");
      const snap = snapshotRepo(dir);
      const payload = buildDiffPayload(snap, "Bump a.", "claude-sonnet-4-5");
      const est = estimateNightJob(payload)!;
      const queue = (task: string) =>
        queueNightJob(db, {
          projectPath: snap.project_path,
          repoSnapshot: snap.bundle_path,
          baseSha: snap.base_sha,
          taskPrompt: task,
          model: "claude-sonnet-4-5",
          estCostMicro: est.batch_micro_usd,
          estStandardMicro: est.standard_micro_usd,
        });
      queue("Bump a.");
      queue("Break b.");
      await runDueJobs(db, { workRoot, testCommand: "true", client: new MockBatchClient(FIX_DIFF) });
      // Second job fixed the same file twice — both done; fail one by hand
      // to prove the stopped rendering.
      const all = listNightJobs(db, "done");
      db.prepare("UPDATE night_jobs SET status = 'failed' WHERE id = ?").run(all[1].id);
      const text = buildDigest(db, workRoot);
      expect(text).toContain("Pru set aside");
      expect(text).toContain("done");
      expect(text).toContain("[verified]");
      expect(text).toContain("failed");
      expect(text).toContain("[stopped]");
      db.close();
      rmSync(snap.bundle_path, { force: true });
    } finally {
      cleanup(dir);
      cleanup(workRoot);
    }
  });
});

describe("scheduler plists", () => {
  test("two ticks, 2am and 6am, same command", () => {
    const two = graveyardPlist({
      label: agentLabel(2),
      hour: 2,
      pruBin: ["/opt/pru"],
      testCommand: "npm test",
      logPath: "/tmp/night.log",
    });
    expect(two).toContain(agentLabel(2));
    expect(two).toContain("<integer>2</integer>");
    expect(two).toContain("--run");
    expect(two).toContain("npm test");
    const six = graveyardPlist({
      label: agentLabel(6),
      hour: 6,
      pruBin: ["/opt/pru"],
      testCommand: "npm test",
      logPath: "/tmp/night.log",
    });
    expect(six).toContain("<integer>6</integer>");
  });

  test("schedule writes and unschedule clears (macOS)", () => {
    if (process.platform !== "darwin") return;
    const home = mkdtempSync(join(tmpdir(), "pru-n3-home-"));
    try {
      const files = scheduleGraveyard({ pruBin: ["/opt/pru"], testCommand: "npm test", home, uid: 59999 });
      expect(files).toHaveLength(2);
      for (const f of files) expect(existsSync(f)).toBe(true);
      const removed = unscheduleGraveyard({ home, uid: 59999 });
      expect(removed).toHaveLength(2);
    } finally {
      cleanup(home);
    }
  });
});
