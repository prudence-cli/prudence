// Graveyard snapshotter (N1): freeze a repo into a bundle + file selection
// the batch diff-builder can reason over. Sync; shells out to git.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Context cap: ~100k tokens of source per job (plan §3.2).
export const SNAPSHOT_MAX_CHARS = 400_000;
const BINARY_SNIFF_BYTES = 8000;

function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    throw new Error(
      `Pru could not snapshot ${cwd}: git ${args[0]} failed. Is this a git repo with at least one commit?`,
    );
  }
}

function looksBinary(filePath: string): boolean {
  try {
    const buf = readFileSync(filePath);
    const head = buf.subarray(0, Math.min(buf.length, BINARY_SNIFF_BYTES));
    return head.includes(0);
  } catch {
    return true;
  }
}

export type SnapshotFile = { path: string; chars: number; content: string };

export type Snapshot = {
  project_path: string;
  base_sha: string;
  bundle_path: string;
  files: SnapshotFile[];
  total_chars: number;
  tokens_est: number;
  truncated: boolean;
};

// Shared file selection: tracked text files under the cap. Used on live
// repos (snapshotRepo) and on frozen bundle checkouts (the runner).
export function readTextFiles(cwd: string): { files: SnapshotFile[]; total_chars: number; truncated: boolean } {
  const tracked = git(cwd, "ls-files").split("\n").map((s) => s.trim()).filter(Boolean);
  const files: SnapshotFile[] = [];
  let total = 0;
  let truncated = false;
  for (const rel of tracked) {
    const abs = join(cwd, rel);
    let size = 0;
    try {
      size = statSync(abs).size;
    } catch {
      continue;
    }
    if (size === 0 || looksBinary(abs)) continue;
    if (total + size > SNAPSHOT_MAX_CHARS) {
      truncated = true;
      continue;
    }
    const content = readFileSync(abs, "utf8");
    total += content.length;
    files.push({ path: rel, chars: content.length, content });
  }
  return { files, total_chars: total, truncated };
}

export function defaultBundlesDir(): string {
  return join(process.env.HOME ?? ".", ".prudence", "night", "bundles");
}

export function snapshotRepo(
  projectPath: string,
  jobId?: string,
  bundleDir?: string,
): Snapshot {
  const cwd = projectPath;
  const baseSha = git(cwd, "rev-parse", "HEAD");
  const id = jobId ?? randomUUID().replace(/-/g, "").slice(0, 12);
  // Bundles persist under ~/.prudence/night/bundles by default: the system
  // temp dir may be cleaned on reboot, vaporizing the bundle between
  // queueing and the 2am submit. Callers (tests) may pass a scratch dir.
  const dir = bundleDir ?? defaultBundlesDir();
  mkdirSync(dir, { recursive: true });
  const bundlePath = join(dir, `pru-graveyard-${id}.bundle`);
  git(cwd, "bundle", "create", bundlePath, "HEAD");

  const { files, total_chars: total, truncated } = readTextFiles(cwd);
  if (files.length === 0) {
    throw new Error(`Pru found no text files to snapshot in ${cwd}.`);
  }
  return {
    project_path: cwd,
    base_sha: baseSha,
    bundle_path: bundlePath,
    files,
    total_chars: total,
    tokens_est: Math.ceil(total / 4),
    truncated,
  };
}
