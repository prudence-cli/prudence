// F4 hardening: file-DB determinism across restarts, concurrent reservations.
// Same mock-upstream discipline: no live keys, ever.

import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRelay, type FetchLike } from "../src/relay/server";
import { getStatus, openLedger, setCap, usdToMicro } from "../src/ledger/db";

const FIX = join(import.meta.dir, "fixtures");
const requestFixture = () =>
  JSON.parse(readFileSync(join(FIX, "anthropic-request.json"), "utf8")) as Record<string, unknown>;

const JSON_UPSTREAM_BODY = JSON.stringify({
  id: "msg_pru_fixture_1",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "The guard goes before the call." }],
  usage: { input_tokens: 150, output_tokens: 90 },
});

function upstream(delayMs = 0) {
  const fetchImpl = (async () => {
    if (delayMs) await Bun.sleep(delayMs);
    return new Response(JSON_UPSTREAM_BODY, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;
  return fetchImpl;
}

async function post(app: Hono, body: unknown) {
  return app.request(
    "http://localhost/v1/messages",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pru-agent": "file-agent",
        "x-pru-project": "file-project",
      },
      body: JSON.stringify(body),
    },
  );
}

const snapshot = (dbPath: string) => {
  const db = openLedger(dbPath);
  const rows = db.query(
    "SELECT model, input_tokens, output_tokens, cached_tokens, cost_micro_usd, tokens_saved, status, truth FROM usage_ledger ORDER BY created_at",
  ).all();
  const refusals = db.query("SELECT type FROM refusal_events ORDER BY id").all();
  db.close();
  return { rows, refusals };
};

describe("file-DB determinism", () => {
  test("close, reopen, continue: books stay consistent", async () => {
    const dbPath = join(tmpdir(), `pru-f4-${Date.now()}.db`);
    try {
      // Session 1: two calls, then the process "restarts".
      {
        const db = openLedger(dbPath);
        const { app } = createRelay({
          db,
          upstreamBaseUrl: "https://api.anthropic.com",
          upstreamApiKey: "sk-test",
          fetchImpl: upstream(),
        });
        for (let i = 0; i < 2; i++) {
          const res = await post(app, requestFixture());
          expect(res.status).toBe(200);
          await res.text();
        }
        db.close();
      }
      // Session 2 (new process, same file): session resumes, spend intact.
      {
        const db = openLedger(dbPath);
        const { app } = createRelay({
          db,
          upstreamBaseUrl: "https://api.anthropic.com",
          upstreamApiKey: "sk-test",
          fetchImpl: upstream(),
        });
        const res = await post(app, requestFixture());
        expect(res.status).toBe(200);
        await res.text();
        const view = getStatus(db)!;
        expect(view.calls).toBe(3);
        expect(view.spent_micro_usd).toBe(3 * 1800);
        db.close();
      }
      // Replay the whole tape on a second file: identical books.
      const dbPath2 = `${dbPath}.replay.db`;
      try {
        {
          const db = openLedger(dbPath2);
          const { app } = createRelay({
            db,
            upstreamBaseUrl: "https://api.anthropic.com",
            upstreamApiKey: "sk-test",
            fetchImpl: upstream(),
          });
          for (let i = 0; i < 3; i++) {
            const res = await post(app, requestFixture());
            expect(res.status).toBe(200);
            await res.text();
          }
          db.close();
        }
        expect(snapshot(dbPath2)).toEqual(snapshot(dbPath));
      } finally {
        for (const f of [dbPath2, `${dbPath2}-wal`, `${dbPath2}-shm`, `${dbPath2}-journal`]) {
          try { rmSync(f); } catch { /* already gone */ }
        }
      }
    } finally {
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
        try { rmSync(f); } catch { /* already gone */ }
      }
    }
  });
});

describe("concurrent reservations", () => {
  test("in-flight burst cannot overshoot past one reservation each", async () => {
    const db = openLedger(":memory:");
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      upstreamApiKey: "sk-test",
      fetchImpl: upstream(30),
    });
    // Fixture cost_max is 4_179 micro; $0.01 admits two reservations.
    const CAP = usdToMicro(0.01);
    setCap(db, "global", "*", CAP);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => post(app, requestFixture()).then(async (r) => {
        await r.text();
        return r.status;
      })),
    );
    const admitted = results.filter((s) => s === 200).length;
    expect(admitted).toBeGreaterThan(0);
    expect(admitted).toBeLessThan(6);
    const view = getStatus(db)!;
    expect(view.spent_micro_usd).toBeLessThanOrEqual(CAP + 4179);
    // No reservation left dangling.
    const dangling = db.query(
      "SELECT COUNT(*) AS n FROM usage_ledger WHERE status = 'reserved'",
    ).get() as { n: number };
    expect(dangling.n).toBe(0);
    const caps = db.query("SELECT * FROM cap_state").all() as Record<string, unknown>[];
    for (const c of caps) expect(c.reserved_micro_usd).toBe(0);
    db.close();
  });
});
