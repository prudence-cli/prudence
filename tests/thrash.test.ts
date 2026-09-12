// F3 thrash simulations: retry storms, guard reset, pacing.
// The F0 shape — an agent hammering a closed ledger — must trip the
// circular-spending guard instead of burning silently.

import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRelay, type FetchLike } from "../src/relay/server";
import {
  getStatus,
  openLedger,
  setCap,
  setRule,
  usdToMicro,
} from "../src/ledger/db";

const FIX = join(import.meta.dir, "fixtures");
const requestFixture = () =>
  JSON.parse(readFileSync(join(FIX, "anthropic-request.json"), "utf8")) as Record<string, unknown>;

const JSON_UPSTREAM_BODY = JSON.stringify({
  id: "msg_pru_fixture_1",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "The guard goes before the call." }],
  usage: { input_tokens: 150, output_tokens: 90 },
});

function stubUpstream() {
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

async function post(app: Hono, body: unknown) {
  return app.request(
    "http://localhost/v1/messages",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pru-agent": "thrash-agent",
        "x-pru-project": "thrash-project",
      },
      body: JSON.stringify(body),
    },
  );
}

type RefusalBody = { error: string; type: string; refusal_id: number };

describe("retry storm (F0 shape)", () => {
  test("consecutive refusals escalate to loop_blocked with the canonical string", async () => {
    const db = openLedger(":memory:");
    const { fetchImpl, calls } = stubUpstream();
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      upstreamApiKey: "sk-test",
      fetchImpl,
    });
    // Fixture cost_max is 4_179 micro; $0.005 admits exactly one call.
    setCap(db, "global", "*", usdToMicro(0.005));

    const seen = new Set<string>();
    let loopMessage = "";
    const before = calls();
    for (let i = 0; i < 8; i++) {
      const res = await post(app, requestFixture());
      if (res.status === 429) {
        const body = (await res.json()) as RefusalBody;
        seen.add(body.type);
        if (body.type === "loop_blocked") loopMessage = body.error;
      } else {
        await res.text();
      }
    }
    // The storm never reached the upstream again after the first call.
    expect(calls() - before).toBe(1);
    expect(seen.has("budget_exhausted")).toBe(true);
    expect(seen.has("loop_blocked")).toBe(true);
    expect(loopMessage).toContain("Pru noticed circular spending: same call");
    const rows = db.query(
      "SELECT type FROM refusal_events ORDER BY id",
    ).all() as { type: string }[];
    expect(rows[0].type).toBe("budget_exhausted");
    expect(rows[rows.length - 1].type).toBe("loop_blocked");
    db.close();
  });
});

describe("guard reset", () => {  test("a posted call clears the strike count", async () => {
    const db = openLedger(":memory:");
    const { fetchImpl } = stubUpstream();
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      upstreamApiKey: "sk-test",
      fetchImpl,
    });
    setCap(db, "global", "*", usdToMicro(0.005));

    const types: string[] = [];
    const fire = async () => {
      const res = await post(app, requestFixture());
      if (res.status === 429) types.push(((await res.json()) as RefusalBody).type);
      else {
        types.push("ok");
        await res.text();
      }
    };
    await fire(); // ok (1 call admitted)
    await fire(); // budget_exhausted (strike 1)
    await fire(); // budget_exhausted (strike 2)
    setCap(db, "global", "*", usdToMicro(10)); // human raises the cap
    await fire(); // ok — strikes reset
    setCap(db, "global", "*", usdToMicro(0.005)); // tight again
    await fire(); // budget_exhausted (strike 1, not loop)
    await fire(); // budget_exhausted (strike 2, still not loop)
    expect(types).toEqual(["ok", "budget_exhausted", "budget_exhausted", "ok", "budget_exhausted", "budget_exhausted"]);
    db.close();
  });
});

describe("pace limit", () => {
  test("trailing-minute spend trips rate_limited before the cap does", async () => {
    const db = openLedger(":memory:");
    const { fetchImpl, calls } = stubUpstream();
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      upstreamApiKey: "sk-test",
      fetchImpl,
    });
    setCap(db, "global", "*", usdToMicro(100)); // cap never binds here
    setRule(db, "global", "*", "rate_limit", { max_usd_per_minute: 0.002 }, 1);

    const first = await post(app, requestFixture());
    expect(first.status).toBe(200);
    await first.text();
    const before = calls();
    const second = await post(app, requestFixture());
    expect(second.status).toBe(429);
    const body = (await second.json()) as RefusalBody;
    expect(body.type).toBe("rate_limited");
    expect(body.error).toContain("Pru is pacing this session");
    expect(calls() - before).toBe(0);
    db.close();
  });

  test("pace off restores full speed", async () => {
    const db = openLedger(":memory:");
    const { fetchImpl } = stubUpstream();
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      upstreamApiKey: "sk-test",
      fetchImpl,
    });
    setRule(db, "global", "*", "rate_limit", { max_usd_per_minute: 0.002 }, 1);
    setRule(db, "global", "*", "rate_limit", {}, 0); // pru pace off
    const res = await post(app, requestFixture());
    expect(res.status).toBe(200);
    await res.text();
    const view = getStatus(db)!;
    expect(view.calls).toBe(1);
    db.close();
  });
});

describe("in-harness packs (thin glue)", () => {
  test("/pru:status reads daemon truth and names the refusal protocol", () => {
    const pack = readFileSync(
      join(import.meta.dir, "..", "packs", "claude-code", "commands", "pru-status.md"),
      "utf8",
    );
    expect(pack).toContain("pru status");
    expect(pack).toContain("refusal");
    expect(pack).toContain("STOP");
  });
  test("codex snippet engraves read-only wallets and STOP", () => {
    const snippet = readFileSync(
      join(import.meta.dir, "..", "packs", "codex", "AGENTS-snippet.md"),
      "utf8",
    );
    expect(snippet).toContain("read-only");
    expect(snippet).toContain("STOP");
  });
});

describe("refusal diagnostics (alternation follow-up)", () => {
  test("every refusal row carries its strike count and daemon pid", async () => {
    const db = openLedger(":memory:");
    const { fetchImpl } = stubUpstream();
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      upstreamApiKey: "sk-test",
      fetchImpl,
    });
    setCap(db, "global", "*", usdToMicro(0.005));
    const first = await post(app, requestFixture());
    expect(first.status).toBe(200); // one reservation fits; its ok resets strikes
    await first.text();
    for (let i = 0; i < 4; i++) {
      const res = await post(app, requestFixture());
      expect(res.status).toBe(429);
      await res.text();
    }
    const rows = db.query(
      "SELECT type, detail FROM refusal_events ORDER BY id",
    ).all() as { type: string; detail: string }[];
    // 4 breach rows (strikes 1-4) + 2 loop rows (strikes 3-4): every row
    // explains itself, so a live alternation mystery reads off the books.
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.detail).toMatch(/^strikes=\d+ pid=\d+$/);
    }
    const budgets = rows.filter((r) => r.type === "budget_exhausted").map((r) => r.detail);
    expect(budgets).toEqual([
      `strikes=1 pid=${process.pid}`,
      `strikes=2 pid=${process.pid}`,
      `strikes=3 pid=${process.pid}`,
      `strikes=4 pid=${process.pid}`,
    ]);
    const loops = rows.filter((r) => r.type === "loop_blocked").map((r) => r.detail);
    expect(loops).toEqual([`strikes=3 pid=${process.pid}`, `strikes=4 pid=${process.pid}`]);
    db.close();
  });
});
