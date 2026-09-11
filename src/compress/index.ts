// Token-compression pass (F3.5, parity vs Runcap).
// Conservative and provable: strip-list only, per-field size floor,
// identical-block dedup that keeps the first occurrence verbatim.
// No delta-encoding: rewriting text into diffs the model must reconstruct
// in its head is not provably lossless, so it stays out.
// Techniques studied from Runcap (MIT, see NOTICE); reimplemented here.

import { createHash } from "node:crypto";

export const CHARS_PER_TOKEN = 4;
export const MIN_FIELD_CHARS = 200;
export const MIN_DEDUP_CHARS = 256;
export const LOG_HEAD_LINES = 12;
export const LOG_TAIL_LINES = 8;
export const LOG_COLLAPSE_THRESHOLD = 40;
export const DEFAULT_MIN_SAVE_TOKENS = 200;

export type StripKind = "logs" | "repeated_json" | "stack_traces";
export type CompressConfig = {
  strip?: StripKind[];
  min_save_tokens?: number;
};

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

function shortHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 8);
}

function wants(config: CompressConfig | undefined, kind: StripKind): boolean {
  if (!config?.strip) return true;
  return config.strip.includes(kind);
}

// Re-serialize an embedded JSON string compactly. Whole-field JSON, or a
// short prose prefix followed by a JSON blob (prefix kept verbatim).
// Returns null when nothing valid and smaller was found.
function compactEmbeddedJson(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const compact = JSON.stringify(JSON.parse(trimmed));
      if (compact.length < value.length) return compact;
    } catch {
      // fall through to prefix handling
    }
  }
  const idx = value.search(/[{[]/);
  if (idx > 0) {
    const prefix = value.slice(0, idx);
    if (prefix.length <= 200) {
      const tail = value.slice(idx).trim();
      try {
        const compact = JSON.stringify(JSON.parse(tail));
        const rebuilt = prefix + compact;
        if (rebuilt.length < value.length) return rebuilt;
      } catch {
        return null;
      }
    }
  }
  return null;
}

const LOG_LINE_RE =
  /^\s*(\d{4}-\d{2}-\d{2}[T ]|\[?\d{2}:\d{2}:\d{2}|DEBUG|INFO|WARN|ERROR|TRACE|at\s+\w|\s+File ")/;

// Collapse a long log-like block to head + tail + elision marker. Only
// fires when the block really looks like logs/stack traces, never prose.
function collapseLogBlock(value: string): string | null {
  const lines = value.split("\n");
  if (lines.length <= LOG_COLLAPSE_THRESHOLD) return null;
  const logish = lines.filter((l) => LOG_LINE_RE.test(l)).length;
  if (logish < lines.length * 0.5) return null;
  const head = lines.slice(0, LOG_HEAD_LINES);
  const tail = lines.slice(-LOG_TAIL_LINES);
  const elided = lines.length - head.length - tail.length;
  if (elided <= 0) return null;
  return [...head, `... (${elided} repetitive log lines elided by Pru) ...`, ...tail].join("\n");
}

// Collapse 3+ blank lines to one; strip trailing whitespace only inside
// multi-line blocks. Single-line prose is never touched.
function squeezeWhitespace(value: string): string | null {
  const lines = value.split("\n");
  if (lines.length < 3) return null;
  const squeezed = lines
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return squeezed.length < value.length ? squeezed : null;
}

function compressField(value: string, config?: CompressConfig): string {
  if (typeof value !== "string" || value.length < MIN_FIELD_CHARS) return value;
  let out = value;
  if (wants(config, "repeated_json")) {
    const json = compactEmbeddedJson(out);
    if (json !== null) out = json;
  }
  if (wants(config, "logs") || wants(config, "stack_traces")) {
    const logs = collapseLogBlock(out);
    if (logs !== null && logs.length < out.length) out = logs;
  }
  const ws = squeezeWhitespace(out);
  if (ws !== null && ws.length < out.length) out = ws;
  return out;
}

// Deduplicate identical content blocks within one request. The first
// occurrence of a block is kept verbatim; repeats become a deterministic
// stub naming the message and hash of the original. Lossless: every byte
// the model needs is still present exactly once, in order.
function dedupRepeatedBlocks(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  saved: number;
  blocks: number;
} {
  let saved = 0;
  let blocks = 0;
  const seen = new Map<string, number>();

  const dedupString = (text: string, msgIndex: number): string => {
    if (typeof text !== "string" || text.length < MIN_DEDUP_CHARS) return text;
    const hash = shortHash(text);
    const first = seen.get(hash);
    if (first === undefined) {
      seen.set(hash, msgIndex);
      return text;
    }
    const stub = `[pru: identical content seen at message ${first + 1}, sha:${hash}]`;
    if (stub.length >= text.length) return text;
    saved += text.length - stub.length;
    blocks += 1;
    return stub;
  };

  const dedupContent = (content: unknown, msgIndex: number): unknown => {
    if (typeof content === "string") return dedupString(content, msgIndex);
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (!part || typeof part !== "object") return part;
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") return { ...p, text: dedupString(p.text, msgIndex) };
        if (p.type === "tool_result") {
          if (typeof p.content === "string") {
            return { ...p, content: dedupString(p.content, msgIndex) };
          }
          if (Array.isArray(p.content)) {
            return {
              ...p,
              content: (p.content as unknown[]).map((c) =>
                c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string"
                  ? { ...(c as Record<string, unknown>), text: dedupString((c as Record<string, string>).text, msgIndex) }
                  : c,
              ),
            };
          }
        }
        return part;
      });
    }
    return content;
  };

  let next: Record<string, unknown> = body;
  if (Array.isArray(body.messages)) {
    next = {
      ...body,
      messages: (body.messages as Record<string, unknown>[]).map((m, i) =>
        m && typeof m === "object" && "content" in m ? { ...m, content: dedupContent(m.content, i) } : m,
      ),
    };
  }
  return { body: next, saved, blocks };
}

export type CompressResult = {
  body: Record<string, unknown>;
  before: number;
  after: number;
  savedChars: number;
  savedTokens: number;
  touched: number;
};

// Walk an OpenAI- or Anthropic-shaped body and compress message content.
// Returns the original body object untouched when nothing pays.
export function compressRequestBody(
  body: Record<string, unknown>,
  config?: CompressConfig,
): CompressResult {
  const empty: CompressResult = {
    body,
    savedChars: 0,
    savedTokens: 0,
    touched: 0,
    before: 0,
    after: 0,
  };
  if (!body || typeof body !== "object") return empty;
  const before = JSON.stringify(body).length;
  let touched = 0;

  const compressContent = (content: unknown): unknown => {
    if (typeof content === "string") {
      const next = compressField(content, config);
      if (next !== content) touched += 1;
      return next;
    }
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
          const p = part as Record<string, unknown>;
          const next = compressField(p.text as string, config);
          if (next !== p.text) touched += 1;
          return { ...p, text: next };
        }
        return part;
      });
    }
    return content;
  };

  let next: Record<string, unknown> = body;
  if (Array.isArray(body.messages)) {
    next = {
      ...body,
      messages: (body.messages as Record<string, unknown>[]).map((m) =>
        m && typeof m === "object" && "content" in m ? { ...m, content: compressContent(m.content) } : m,
      ),
    };
  }
  if (next.system !== undefined) {
    next = { ...next, system: compressContent(next.system) };
  }
  if (typeof next.input === "string") {
    next = { ...next, input: compressContent(next.input) };
  }

  const deduped = dedupRepeatedBlocks(next);
  next = deduped.body;
  touched += deduped.blocks;

  const after = JSON.stringify(next).length;
  const savedChars = Math.max(0, before - after);
  return {
    body: next,
    before,
    after,
    savedChars,
    savedTokens: Math.round(savedChars / CHARS_PER_TOKEN),
    touched,
  };
}
