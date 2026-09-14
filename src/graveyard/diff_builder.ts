// Graveyard diff builder (N1): turn a snapshot + task into a batch payload
// with exact 50%-off math. No network here — submission is N2.

import { priceTokensMicro } from "../ledger/pricing";
import type { Snapshot } from "./snapshot";

export const DIFF_SYSTEM =
  "You are a precise code editor working from a frozen snapshot. " +
  "Return ONLY a git-apply-compatible unified diff against the files below. " +
  "Paths MUST use a/ b/ prefixes (--- a/path, +++ b/path); new files use " +
  "--- /dev/null as the source. End the diff with a trailing newline. " +
  "No prose, no fences, no explanations. " +
  "If the task cannot be done as a diff, return an empty diff.";
export const DIFF_MAX_OUTPUT_TOKENS = 8192;

export type DiffPayload = {
  model: string;
  system: string;
  user: string;
  input_tokens_est: number;
  max_output_tokens: number;
};

export function buildDiffPayload(snapshot: Snapshot, taskPrompt: string, model: string): DiffPayload {
  const task = taskPrompt.trim();
  if (!task) throw new Error("Pru needs a task description to queue a night job.");
  const files = snapshot.files
    .map((f) => `--- file: ${f.path} ---\n${f.content}`)
    .join("\n\n");
  const user =
    `Task: ${task}\n\nBase commit: ${snapshot.base_sha}\n\n` +
    `Files (${snapshot.files.length}${snapshot.truncated ? ", context truncated at cap" : ""}):\n${files}`;
  return {
    model,
    system: DIFF_SYSTEM,
    user,
    input_tokens_est: Math.max(1, Math.ceil((DIFF_SYSTEM.length + user.length) / 4)),
    max_output_tokens: DIFF_MAX_OUTPUT_TOKENS,
  };
}

export type NightEstimate = {
  standard_micro_usd: number;
  batch_micro_usd: number;
  saved_micro_usd: number;
};

// Same token counts both ways: the 50% is exact arithmetic, not a slogan.
export function estimateNightJob(payload: DiffPayload): NightEstimate | null {
  const standard = priceTokensMicro(payload.input_tokens_est, payload.max_output_tokens, payload.model, false);
  const batch = priceTokensMicro(payload.input_tokens_est, payload.max_output_tokens, payload.model, true);
  if (standard === null || batch === null) return null;
  return {
    standard_micro_usd: standard,
    batch_micro_usd: batch,
    saved_micro_usd: Math.max(0, standard - batch),
  };
}

const DIFF_START = /^(diff --git |--- )/;
const DIFF_LINE =
  /^(diff --git |--- |\+\+\+ |@@ |[ +-]|\\|index |old mode|new mode|new file mode|deleted file mode|Binary |$)/;

// Live-fire lesson: models wrap diffs in prose despite the system prompt
// ("I'll add headers…" preamble killed a real night). Sanitizing transport
// violations is safe — `git apply --check` plus the test comparison still
// judge the content. Anything unsalvageable stays a conflict.
export function sanitizeDiff(raw: string): string {
  let text = String(raw ?? "");
  // Fenced block? Take the inside.
  const fence = text.match(/```(?:diff|patch)?\s*\n([\s\S]*?)\n```/);
  if (fence) text = fence[1];
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length && !DIFF_START.test(lines[start])) start += 1;
  if (start >= lines.length) return "";
  // Trailing blank lines are never meaningful at diff end; drop them along
  // with any trailing prose so the artifact ends on content.
  let end = lines.length;
  while (end > start && (lines[end - 1] === "" || !DIFF_LINE.test(lines[end - 1]))) end -= 1;
  return lines.slice(start, end).join("\n") + "\n";
}
