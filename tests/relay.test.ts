// F2 acceptance: fixture replay, $0.10 ledger close, determinism, abort.
// Never touches a real LLM API — the upstream is a stub fetch.

import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRelay, type FetchLike } from "../src/relay/server";
import {
  fmtUsd,
  getStatus,
  openLedger,
  setCap,
  usdToMicro,
} from "../src/ledger/db";
import { actualCostMicro, estimateCall } from "../src/ledger/pricing";

const FIX = join(import.meta.dir, "fixtures");
const requestFixture = () =>
  JSON.parse(readFileSync(join(FIX, "anthropic-request.json"), "utf8")) as Record<string, unknown>;
const sseFixture = () => readFileSync(join(FIX, "anthropic-sse.txt"), "utf8");

const JSON_UPSTREAM_BODY = JSON.stringify({
  id: "msg_pru_fixture_1",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "The guard goes before the call." }],
  usage: { input_tokens: 150, output_tokens: 90 },
});

function jsonUpstream() {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON_UPSTREAM_BODY, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;
  return { fetchImpl, calls: () => calls };
}

async function post(app: Hono, body: unknown, signal?: AbortSignal) {
  return app.request(
    "http://localhost/v1/messages",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pru-agent": "test-agent",
        "x-pru-project": "test-project",
      },
      body: JSON.stringify(body),
      signal,
    },
  );
}

describe("money math (integer micro-USD)", () => {
  test("round-trips through usdToMicro", () => {
    expect(usdToMicro(5)).toBe(5_000_000);
    expect(usdToMicro(0.1)).toBe(100_000);
  });
  test("fmtUsd only at display boundaries", () => {
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(5_000_000)).toBe("$5.00");
    expect(fmtUsd(1500)).toBe("$0.0015");
  });
});

describe("envelope estimator", () => {
  test("unknown model refuses to guess", () => {
    const est = estimateCall(
      { model: "mystery-9000", input_text: "hello" },
      { session_id: "s", spent_micro_usd: 0, reserved_micro_usd: 0, cap_micro_usd: 100 },
    );
    expect(est.ok).toBe(false);
    if (!est.ok) expect(est.truth).toBe("unknown_price");
  });
  test("measures text, stays integer", () => {
    const est = estimateCall(
      { model: "claude-sonnet-4-5", input_text: "abcd", max_output_tokens: 10 },
      { session_id: "s", spent_micro_usd: 0, reserved_micro_usd: 0, cap_micro_usd: null },
    );
    expect(est.ok).toBe(true);
    if (est.ok) {
      // 1 token in at $3/1M + 10 out at $15/1M = 3 + 150 micro.
      expect(est.cost_max_micro_usd).toBe(153);
      expect(Number.isInteger(est.cost_max_micro_usd)).toBe(true);
    }
  });
  test("actuals from provider usage", () => {
    // 150 in at $3/1M + 90 out at $15/1M = 450 + 1350.
    expect(actualCostMicro({ input_tokens: 150, output_tokens: 90 }, "claude-sonnet-4-5")).toBe(1800);
    expect(actualCostMicro({ input_tokens: 150, output_tokens: 90 }, "mystery-9000")).toBeNull();
  });
});

describe("relay with no caps (transparent passthrough + books)", () => {
  test("forwards untouched and posts real token counts", async () => {
    const db = openLedger(":memory:");
    const { fetchImpl } = jsonUpstream();
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      upstreamApiKey: "sk-test",
      fetchImpl,
    });
    const res = await post(app, requestFixture());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON_UPSTREAM_BODY);
    const view = getStatus(db)!;
    expect(view.calls).toBe(1);
    expect(view.spent_micro_usd).toBe(1800);
    expect(view.caps).toHaveLength(0);
    db.close();
  });
});

describe("ledger close ($0.10 cap)", () => {
  test("halts with the canonical string, leaks nothing past one reservation", async () => {
    const db = openLedger(":memory:");
    let upstreamCalls = 0;
    const fetchImpl = (async () => {
      upstreamCalls++;
      return new Response(JSON_UPSTREAM_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as FetchLike;
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      upstreamApiKey: "sk-test",
      fetchImpl,
    });
    const CAP = usdToMicro(0.1);
    setCap(db, "global", "*", CAP);

    let refusals = 0;
    let lastBody = "";
    for (let i = 0; i < 500 && refusals === 0; i++) {
      const res = await post(app, requestFixture());
      if (res.status === 429) {
        refusals++;
        lastBody = await res.text();
      } else {
        await res.text();
      }
    }
    expect(refusals).toBe(1);
    expect(lastBody).toContain("Pru closed the ledger for this session");
    // The refused call never reached the upstream.
    const afterRefusal = await post(app, requestFixture());
    expect(afterRefusal.status).toBe(429);
    await afterRefusal.text();
    const view = getStatus(db)!;
    expect(view.spent_micro_usd).toBeGreaterThan(0);
    // Overshoot past the cap is bounded by a single reservation.
    // Fixture cost_max is 4_179 micro; the ledger must never exceed cap + 1 reservation.
    expect(view.spent_micro_usd).toBeLessThanOrEqual(CAP + 4_179);
    const rows = db.query("SELECT * FROM refusal_events").all() as unknown[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    db.close();
  });
});

describe("replay determinism", () => {
  test("same session twice keeps identical books", async () => {
    const run = async () => {
      const db = openLedger(":memory:");
      const { fetchImpl } = jsonUpstream();
      const { app } = createRelay({
        db,
        upstreamBaseUrl: "https://api.anthropic.com",
        upstreamApiKey: "sk-test",
        fetchImpl,
      });
      for (let i = 0; i < 3; i++) {
        const res = await post(app, requestFixture());
        expect(res.status).toBe(200);
        await res.text();
      }
      const rows = db.query(
        "SELECT model, input_tokens, output_tokens, cost_micro_usd, status, truth FROM usage_ledger ORDER BY created_at",
      ).all();
      db.close();
      return rows;
    };
    expect(await run()).toEqual(await run());
  });
});

describe("streaming SSE (passthrough tap)", () => {
  test("forwards every chunk in order and reconciles from the tap", async () => {
    const db = openLedger(":memory:");
    const sse = sseFixture();
    const fetchImpl = (async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as FetchLike;
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      upstreamApiKey: "sk-test",
      fetchImpl,
    });
    const res = await post(app, { ...requestFixture(), stream: true });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(sse);
    // Tap runs after the last chunk; poll briefly for reconciliation.
    for (let i = 0; i < 100; i++) {
      const row = db.query("SELECT status FROM usage_ledger").get() as { status: string } | null;
      if (row && row.status !== "reserved") break;
      await Bun.sleep(10);
    }
    const row = db.query("SELECT * FROM usage_ledger").get() as Record<string, unknown>;
    expect(row.status).toBe("ok");
    expect(row.input_tokens).toBe(150);
    expect(row.output_tokens).toBe(90);
    expect(row.cost_micro_usd).toBe(1800);
    db.close();
  });
});

describe("mid-stream abort", () => {
  test("releases the reservation and marks the row aborted", async () => {
    const db = openLedger(":memory:");
    setCap(db, "global", "*", usdToMicro(10));
    const sse = sseFixture();
    const fetchImpl = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          for (const chunk of sse.split("\n\n")) {
            controller.enqueue(enc.encode(chunk + "\n\n"));
            await Bun.sleep(20);
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as FetchLike;
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      upstreamApiKey: "sk-test",
      fetchImpl,
    });
    const controller = new AbortController();
    const pending = post(app, { ...requestFixture(), stream: true }, controller.signal);
    const res = await pending;
    const reader = res.body!.getReader();
    await reader.read(); // first chunk lands, stream stays open
    controller.abort();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Aborted mid-stream: the client is gone, the books must still settle.
    }
    for (let i = 0; i < 100; i++) {
      const row = db.query("SELECT status FROM usage_ledger").get() as { status: string } | null;
      if (row && row.status !== "reserved") break;
      await Bun.sleep(10);
    }
    const row = db.query("SELECT * FROM usage_ledger").get() as Record<string, unknown>;
    expect(row.status).toBe("aborted");
    expect(row.reserved_micro_usd).toBe(0);
    const cap = db.query("SELECT * FROM cap_state").get() as Record<string, unknown>;
    expect(cap.reserved_micro_usd).toBe(0);
    expect(cap.spent_micro_usd).toBe(0);
    db.close();
  });
});

describe("unpriced model under a cap", () => {
  test("fails closed instead of guessing", async () => {
    const db = openLedger(":memory:");
    setCap(db, "global", "*", usdToMicro(10));
    const { fetchImpl } = jsonUpstream();
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      upstreamApiKey: "sk-test",
      fetchImpl,
    });
    const res = await post(app, { ...requestFixture(), model: "mystery-9000" });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("unknown_price");
    db.close();
  });
});

describe("claude-code agent shape (synthetic live-shape fixture)", () => {
  test("tool_use turns with cached usage post exact actuals", async () => {
    const db = openLedger(":memory:");
    const sse = readFileSync(join(FIX, "claude-code-stream-sse.txt"), "utf8");
    const fetchImpl = (async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as FetchLike;
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      upstreamApiKey: "sk-test",
      fetchImpl,
    });
    const body = JSON.parse(
      readFileSync(join(FIX, "claude-code-session.json"), "utf8"),
    ) as Record<string, unknown>;
    const res = await post(app, { ...body, stream: true });
    expect(res.status).toBe(200);
    await res.text();
    for (let i = 0; i < 100; i++) {
      const row = db.query("SELECT status FROM usage_ledger").get() as { status: string } | null;
      if (row && row.status !== "reserved") break;
      await Bun.sleep(10);
    }
    const row = db.query("SELECT * FROM usage_ledger").get() as Record<string, unknown>;
    expect(row.status).toBe("ok");
    expect(row.input_tokens).toBe(1200);
    expect(row.output_tokens).toBe(300);
    expect(row.cached_tokens).toBe(8000);
    // 1200 fresh in at $3/1M is 0 here (all cached): 8000 cached at $0.30/1M
    // + 300 out at $15/1M = 2400 + 4500.
    expect(row.cost_micro_usd).toBe(6900);
    db.close();
  });
});
