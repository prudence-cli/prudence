// N1 acceptance: real repo → valid batch payload, dry-run queue.
// Repos are throwaway tmp dirs. No network, no Batch API submission (N2).

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotRepo, SNAPSHOT_MAX_CHARS } from "../src/graveyard/snapshot";
import { buildDiffPayload, DIFF_MAX_OUTPUT_TOKENS, estimateNightJob } from "../src/graveyard/diff_builder";
import { listNightJobs, openLedger, queueNightJob } from "../src/ledger/db";

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
