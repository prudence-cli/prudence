// Pru relay: Hono app factory. Request path per docs/relay-design.md §a.
// Never buffers SSE: streaming responses pass each chunk through
// immediately while a parallel tap accumulates text for usage parsing.

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  abortCall,
  applicableCaps,
  applicableRules,
  ensureSession,
  fmtUsd,
  insertRefusal,
  loopWindow,
  minuteSpendMicro,
  openLedger,
  reconcileCall,
  reserveCall,
  sessionSpentMicro,
  type Refusal,
} from "../ledger/db";
import { compressRequestBody, DEFAULT_MIN_SAVE_TOKENS, type CompressConfig } from "../compress/index";
import {
  actualCostMicro,
  estimateCall,
  type UsageIn,
} from "../ledger/pricing";

export type RelayOptions = {
  db?: Database;
  dbPath?: string;
  upstreamBaseUrl: string;
  upstreamApiKey?: string;
  anthropicVersion?: string;
  fetchImpl?: typeof fetch;
};

export type RelayContext = {
  app: Hono;
  db: Database;
  upstreamBaseUrl: string;
};

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function isAnthropicPath(path: string): boolean {
  return path.startsWith("/v1/messages");
}

// Upstream base URLs already include /v1; strip our doubled prefix so we
// never produce /v1/v1 (adopted from Runcap 0.6.0).
export function upstreamUrlFor(base: string, path: string): string {
  const cleanBase = base.replace(/\/$/, "");
  const rest = /\/v1\/?$/.test(cleanBase) ? path.replace(/^\/v1/, "") : path;
  return `${cleanBase}${rest}`;
}

// Message text only — the JSON envelope is never measured (relay-design §c).
function extractInputText(body: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (content: unknown) => {
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const p of content) {
        if (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string") {
          parts.push((p as { text: string }).text);
        }
      }
    }
  };
  if (Array.isArray(body.messages)) {
    for (const m of body.messages as Record<string, unknown>[]) {
      if (m && typeof m === "object") push(m.content);
    }
  }
  if (body.system !== undefined) push(body.system as unknown);
  if (typeof body.input === "string") push(body.input);
  if (typeof body.prompt === "string") push(body.prompt);
  return parts.join("\n");
}

function declaredMaxTokens(body: Record<string, unknown>): number | undefined {
  for (const k of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    const v = body[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return undefined;
}

// Non-streaming usage envelopes, both providers.
export function usageFromJson(body: unknown): UsageIn | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const u = b.usage as Record<string, unknown> | undefined;
  if (!u || typeof u !== "object") return null;
  const cached = Number(
    u.cache_read_input_tokens ??
      (u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ??
      0,
  );
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? NaN);
  const output = Number(u.completion_tokens ?? u.output_tokens ?? NaN);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return {
    input_tokens: Number.isFinite(input) ? input : 0,
    output_tokens: Number.isFinite(output) ? output : 0,
    cached_tokens: Number.isFinite(cached) ? cached : 0,
  };
}

// SSE tap parser: merge usage objects across data frames. Providers send
// cumulative counters, so per-field max is the correct merge.
export function usageFromSse(sseText: string): UsageIn | null {
  let input = 0;
  let output = 0;
  let cached = 0;
  let seen = false;
  for (const frame of sseText.split("\n\n")) {
    for (const line of frame.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let data: unknown;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      const found = usageFromJson(data);
      if (found) {
        seen = true;
        input = Math.max(input, found.input_tokens ?? 0);
        output = Math.max(output, found.output_tokens ?? 0);
        cached = Math.max(cached, found.cached_tokens ?? 0);
        continue;
      }
      // Anthropic nests usage one level deeper on some events.
      if (data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        for (const key of ["message", "delta"]) {
          const inner = d[key];
          if (inner && typeof inner === "object") {
            const nested = usageFromJson({ usage: (inner as Record<string, unknown>).usage });
            if (nested) {
              seen = true;
              input = Math.max(input, nested.input_tokens ?? 0);
              output = Math.max(output, nested.output_tokens ?? 0);
              cached = Math.max(cached, nested.cached_tokens ?? 0);
            }
          }
        }
      }
    }
  }
  return seen ? { input_tokens: input, output_tokens: output, cached_tokens: cached } : null;
}

function refusalBody(refusal: Refusal) {
  return {
    error: refusal.message,
    type: refusal.type,
    refusal_id: refusal.id,
    session_id: refusal.session_id,
    truth: "pru_refusal",
  };
}

export function createRelay(opts: RelayOptions): RelayContext {
  const db = opts.db ?? openLedger(opts.dbPath);
  const upstreamBase = opts.upstreamBaseUrl;
  const apiKey = opts.upstreamApiKey;
  const anthropicVersion = opts.anthropicVersion ?? "2023-06-01";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const app = new Hono();

  // Loop guard: consecutive refusal strikes per session. A call that posts
  // actuals clears the count; hammering a closed ledger raises it. At the
  // window the refusal escalates to loop_blocked — refusal-retries are the
  // ground-zero loop signal (PROGRESS §5 answer 5). In-memory by design: the
  // storm it catches happens inside one daemon run.
  const loopStrikes = new Map<string, number>();
  const noteRefusal = (sessionId: string, reqHash: string): Refusal | null => {
    const strikes = (loopStrikes.get(sessionId) ?? 0) + 1;
    loopStrikes.set(sessionId, strikes);
    if (strikes < loopWindow(db)) return null;
    const spent = sessionSpentMicro(db, sessionId);
    return insertRefusal(db, {
      sessionId,
      type: "loop_blocked",
      spentMicro: spent,
      reqHash,
      message:
        `Pru noticed circular spending: same call ${strikes}× (${fmtUsd(spent)}). ` +
        `Stop and report this refusal to your human before retrying.`,
    });
  };

  app.get("/health", (c) => {
    const caps = db.query("SELECT COUNT(*) AS n FROM cap_state").get() as { n: number };
    return c.json({
      ok: true,
      upstream: upstreamBase,
      key_configured: Boolean(apiKey),
      caps_armed: caps.n,
      truth: "pru_ledger",
    });
  });

  app.post("/v1/*", async (c) => {
    const path = new URL(c.req.url).pathname;
    const bodyText = await c.req.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
      if (!body || typeof body !== "object") throw new Error("not an object");
    } catch {
      return c.text("Pru expects a JSON request body.", 400);
    }

    const agent = c.req.header("x-pru-agent") ?? "unknown";
    const project = c.req.header("x-pru-project") ?? "unknown";
    const session = ensureSession(db, agent, project);
    const model = typeof body.model === "string" ? body.model : "unknown";
    const reqHash = sha1(bodyText);
    const streaming = body.stream === true;

    // Pre-flight: price the call inside its envelope, then reserve inside
    // one transaction. Fits → reserved += cost_max. Breach → typed refusal.
    const caps = applicableCaps(db, session);
    const spent = caps.reduce((m, cap) => Math.max(m, cap.spent_micro_usd), 0);
    const reserved = caps.reduce((m, cap) => Math.max(m, cap.reserved_micro_usd), 0);
    const tightestCap = caps.length
      ? caps.reduce((a, b) =>
          a.limit_micro_usd - a.spent_micro_usd - a.reserved_micro_usd <=
          b.limit_micro_usd - b.spent_micro_usd - b.reserved_micro_usd
            ? a
            : b,
        ).limit_micro_usd
      : null;

    const estimate = estimateCall(
      { model, input_text: extractInputText(body), max_output_tokens: declaredMaxTokens(body) },
      {
        session_id: session.id,
        spent_micro_usd: spent,
        reserved_micro_usd: reserved,
        cap_micro_usd: tightestCap,
      },
    );

    // Fail closed on unpriced models for capped sessions; uncapped sessions
    // pass through with an honest unknown_price marker (never guess).
    if (!estimate.ok) {
      if (tightestCap !== null) {
        const refusal = insertRefusal(db, {
          sessionId: session.id,
          type: "unknown_price",
          spentMicro: spent,
          capMicro: tightestCap,
          reqHash,
          message:
            `Pru cannot price model "${model}" — refusing a capped session rather than guessing. ` +
            `Set a price or relax the watch: pru budget off.`,
        });
        return c.json(refusalBody(noteRefusal(session.id, reqHash) ?? refusal), 429);
      }
    }

    const costMax = estimate.ok ? estimate.cost_max_micro_usd : 0;

    // Compression pass (F3.5): conservative strip-list on a clone, gated by
    // min_save_tokens. The guard above stays pessimistic — it priced the
    // ORIGINAL body. req_hash likewise identifies the agent's intent, not
    // the transported bytes. Off-switch: disable the compression rule or
    // set PRU_COMPRESS=off.
    let forwardBody = bodyText;
    let tokensSaved = 0;
    // First enabled rule in session > project > global order; none means
    // byte-identical passthrough (transparent by default).
    const compressRules = applicableRules(db, "compression", session);
    const compressCfg =
      compressRules.length > 0 ? (compressRules[0].config as CompressConfig) : undefined;
    if (process.env.PRU_COMPRESS !== "off" && compressCfg !== undefined) {
      const minSave =
        Number.isFinite(Number(compressCfg?.min_save_tokens)) && Number(compressCfg?.min_save_tokens) > 0
          ? Math.floor(Number(compressCfg?.min_save_tokens))
          : DEFAULT_MIN_SAVE_TOKENS;
      const c = compressRequestBody(body, compressCfg);
      if (c.savedTokens >= minSave && c.touched > 0) {
        forwardBody = JSON.stringify(c.body);
        tokensSaved = c.savedTokens;
      }
    }

    // Pace check: trailing-minute spend plus this call against every armed
    // rate_limit rule (session > project > global). In-flight reservations
    // count — a concurrent burst trips the pace before any call reconciles.
    // Token-bucket edge: an empty window always admits one call, so a pace
    // below a single call's pessimistic estimate slows traffic instead of
    // locking the session out forever.
    const paceRules = applicableRules(db, "rate_limit", session);
    {
      const minute = minuteSpendMicro(db, session.id);
      for (const rule of paceRules) {
        const maxPerMinute = Number(rule.config.max_usd_per_minute ?? rule.config.max_micro_usd_per_minute);
        const maxMicro =
          rule.config.max_micro_usd_per_minute !== undefined
            ? Number(rule.config.max_micro_usd_per_minute)
            : Number.isFinite(maxPerMinute)
              ? Math.round(maxPerMinute * 1_000_000)
              : NaN;
        if (Number.isFinite(maxMicro) && maxMicro >= 0 && minute + costMax > maxMicro && minute > 0) {
          const refusal = insertRefusal(db, {
            sessionId: session.id,
            type: "rate_limited",
            spentMicro: spent,
            capMicro: maxMicro,
            callEstimateMicro: costMax,
            reqHash,
            message:
              `Pru is pacing this session: ${fmtUsd(minute)} in the last minute (limit ${fmtUsd(maxMicro)}/min). ` +
              `Retry shortly — the meter resets every sixty seconds.`,
          });
          return c.json(refusalBody(noteRefusal(session.id, reqHash) ?? refusal), 429);
        }
      }
    }

    const reservation = reserveCall(db, {
      session,
      upstream: isAnthropicPath(path) ? "anthropic" : "openai",
      model,
      costMaxMicro: costMax,
      reqHash,
      tokensSaved,
    });
    if (!reservation.ok) {
      return c.json(refusalBody(noteRefusal(session.id, reqHash) ?? reservation.refusal), 429);
    }
    const ledgerId = reservation.ledgerId;

    // Client abort: release the reservation, mark the row. Idempotent with
    // reconcile — only the first one out of 'reserved' wins.
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      try {
        abortCall(db, ledgerId);
      } catch {
        // Parsing degraded; the stream already answered. Never throw here.
      }
    };
    c.req.raw.signal.addEventListener("abort", onAbort, { once: true });

    if (!apiKey) {
      const refusal = insertRefusal(db, {
        sessionId: session.id,
        type: "key_missing",
        spentMicro: spent,
        reqHash,
        message:
          "Pru has no upstream key for this route. Set it in ~/.prudence/config.yaml, then retry.",
      });
      reconcileCall(db, { ledgerId, costMicro: 0, status: "aborted", truth: "aborted" });
      settled = true;
      return c.json(refusalBody(noteRefusal(session.id, reqHash) ?? refusal), 429);
    }

    const anthropic = isAnthropicPath(path);
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (anthropic) {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = anthropicVersion;
    } else {
      headers["authorization"] = `Bearer ${apiKey}`;
    }

    let upstream: Response;
    try {
      upstream = await fetchImpl(upstreamUrlFor(upstreamBase, path), {
        method: "POST",
        headers,
        body: forwardBody,
      });
    } catch (err) {
      reconcileCall(db, {
        ledgerId,
        costMicro: 0,
        status: "upstream_error",
        truth: "unknown",
      });
      settled = true;
      return c.json(
        { error: `Pru could not reach the upstream: ${(err as Error).message}`, truth: "upstream_error" },
        502,
      );
    }

    const contentType = upstream.headers.get("content-type") ?? "application/json";

    // Non-streaming: complete body, reconcile before responding.
    if (!streaming) {
      const text = await upstream.text();
      const usage = usageFromJson(safeJson(text));
      const cost = usage ? (actualCostMicro(usage, model) ?? 0) : 0;
      const status = upstream.ok ? "ok" : `error_${upstream.status}`;
      reconcileCall(db, {
        ledgerId,
        costMicro: cost,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        cachedTokens: usage?.cached_tokens,
        status,
        truth: usage ? "provider_usage" : "unknown",
      });
      if (status === "ok") loopStrikes.set(session.id, 0);
      settled = true;
      return new Response(text, {
        status: upstream.status,
        headers: { "content-type": contentType, "cache-control": "no-store" },
      });
    }

    // Streaming: forward every chunk immediately; the tap accumulates text
    // for usage parsing and reconciles when the upstream finishes. If the
    // tap cannot find usage, the row is flagged degraded_parse — the stream
    // itself is never held back.
    const reader = upstream.body?.getReader();
    if (!reader) {
      const text = await upstream.text();
      const usage = usageFromSse(text) ?? usageFromJson(safeJson(text));
      const cost = usage ? (actualCostMicro(usage, model) ?? 0) : 0;
      const status = upstream.ok ? "ok" : `error_${upstream.status}`;
      reconcileCall(db, {
        ledgerId,
        costMicro: cost,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        cachedTokens: usage?.cached_tokens,
        status,
        truth: usage ? "provider_usage" : "degraded_parse",
      });
      if (status === "ok") loopStrikes.set(session.id, 0);
      settled = true;
      return new Response(text, {
        status: upstream.status,
        headers: { "content-type": contentType, "cache-control": "no-store" },
      });
    }

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const decoder = new TextDecoder();
    let acc = "";
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          await writer.write(value);
        }
        acc += decoder.decode();
        const usage = usageFromSse(acc);
        const cost = usage ? (actualCostMicro(usage, model) ?? 0) : 0;
        if (!settled) {
          settled = true;
          const status = upstream.ok ? "ok" : `error_${upstream.status}`;
          reconcileCall(db, {
            ledgerId,
            costMicro: cost,
            inputTokens: usage?.input_tokens,
            outputTokens: usage?.output_tokens,
            cachedTokens: usage?.cached_tokens,
            status,
            truth: usage ? "provider_usage" : "degraded_parse",
          });
          if (status === "ok") loopStrikes.set(session.id, 0);
        }
      } catch {
        onAbort();
      } finally {
        try {
          await writer.close();
        } catch {
          // Client already gone; ledger already settled.
        }
      }
    })();

    return new Response(stream.readable, {
      status: upstream.status,
      headers: { "content-type": contentType, "cache-control": "no-store" },
    });
  });

  return { app, db, upstreamBaseUrl: upstreamBase };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export { fmtUsd };
