// P1 acceptance (spec docs/subscription-passthrough.md §7).
// Subscriber mode: client credentials forwarded verbatim, enforcement in
// calls/tokens, dollars honestly NULL. Mock upstream only.

import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelay, type FetchLike } from "../src/relay/server";
import { getStatus, openLedger, setCap } from "../src/ledger/db";

const SUBSCRIPTION_KEY = "sk-ant-oat-canary-01H9zT3fQaW8sD7xY6vB";

const JSON_UPSTREAM_BODY = JSON.stringify({
  id: "msg_sub_1",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "metered, not billed." }],
  usage: { input_tokens: 150, output_tokens: 90 },
});

function mockUpstream() {
  let calls = 0;
  let auth: string | null = null;
  const fetchImpl: FetchLike = async (_url, init) => {
    calls++;
    auth = new Headers(init?.headers).get("authorization");
    return new Response(JSON_UPSTREAM_BODY, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls: () => calls, auth: () => auth };
}

async function post(app: Hono, body: unknown, auth?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-pru-agent": "subscriber",
    "x-pru-project": "subscriber-project",
  };
  if (auth !== undefined) headers["authorization"] = auth;
  return app.request("http://localhost/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const smallBody = () => ({
  model: "claude-sonnet-4-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "hi" }],
});

describe("passthrough credential discipline", () => {
  test("exact Authorization value arrives; never persists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pru-pass-"));
    try {
      const dbPath = join(dir, "ledger.db");
      const db = openLedger(dbPath);
      const mock = mockUpstream();
      const { app } = createRelay({
        db,
        upstreamBaseUrl: "https://api.anthropic.com",
        authMode: "passthrough",
        fetchImpl: mock.fetchImpl,
      });
      const res = await post(app, smallBody(), `Bearer ${SUBSCRIPTION_KEY}`);
      expect(res.status).toBe(200);
      await res.text();
      expect(mock.auth()).toBe(`Bearer ${SUBSCRIPTION_KEY}`);
      db.close();
      for (const f of ["ledger.db", "ledger.db-wal", "ledger.db-shm", "ledger.db-journal"]) {
        const p = join(dir, f);
        if (existsSync(p)) expect(readFileSync(p, "latin1")).not.toContain(SUBSCRIPTION_KEY);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing client auth fails closed, names nothing secret", async () => {
    const db = openLedger(":memory:");
    const mock = mockUpstream();
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      authMode: "passthrough",
      fetchImpl: mock.fetchImpl,
    });
    const res = await post(app, smallBody());
    expect(res.status).toBe(429);
    const body = (await res.json()) as { type: string; error: string };
    expect(body.type).toBe("key_missing");
    expect(body.error).not.toContain("Bearer");
    expect(mock.calls()).toBe(0);
    db.close();
  });
});

describe("calls-unit caps ($0.10-style acceptance in calls)", () => {
  test("200-call cap halts the 201st with the calls-exhausted string", async () => {
    const db = openLedger(":memory:");
    const mock = mockUpstream();
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      authMode: "passthrough",
      fetchImpl: mock.fetchImpl,
    });
    setCap(db, "global", "*", 200, "calls");
    for (let i = 0; i < 200; i++) {
      const res = await post(app, smallBody(), `Bearer ${SUBSCRIPTION_KEY}`);
      expect(res.status).toBe(200);
      await res.text();
    }
    const refused = await post(app, smallBody(), `Bearer ${SUBSCRIPTION_KEY}`);
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { type: string; error: string };
    expect(body.error).toContain("Pru closed the ledger for this session (200 calls).");
    expect(mock.calls()).toBe(200);
    const view = getStatus(db)!;
    // Priced models still book real dollars alongside unit enforcement.
    expect(view.spent_micro_usd).toBe(200 * 1800);
    expect(view.spent_tokens).toBe(200 * (150 + 90));
    const cap = view.caps[0];
    expect(cap.spent_native).toBeLessThanOrEqual(201);
    db.close();
  });
});

describe("token-unit enforcement on unpriced models", () => {
  test("tokens enforce without prices; no unknown_price refusal", async () => {
    const db = openLedger(":memory:");
    const mock = mockUpstream();
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      authMode: "passthrough",
      fetchImpl: mock.fetchImpl,
    });
    // Generous token cap: an unpriced model still flows on measure.
    setCap(db, "global", "*", 1_000_000, "tokens");
    const ok = await post(app, { ...smallBody(), model: "mystery-9000" }, `Bearer ${SUBSCRIPTION_KEY}`);
    expect(ok.status).toBe(200);
    await ok.text();
    // Tight token cap: refusal names tokens, never unknown_price.
    setCap(db, "global", "*", 1, "tokens");
    const res = await post(app, { ...smallBody(), model: "mystery-9000" }, `Bearer ${SUBSCRIPTION_KEY}`);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { type: string; error: string };
    expect(body.type).toBe("budget_exhausted");
    expect(body.error).toContain("tokens).");
    db.close();
  });
});
