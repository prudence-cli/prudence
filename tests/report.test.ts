// Report acceptance (spec docs/report-spec.md §5): figures equal the
// ledger, no remote assets, hostile strings escaped. Mock upstream only.

import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { buildReportHtml } from "../src/report";
import { createRelay, type FetchLike } from "../src/relay/server";
import {
  openLedger,
  queueNightJob,
  recordTally,
  setCap,
  usdToMicro,
} from "../src/ledger/db";

const JSON_UPSTREAM_BODY = JSON.stringify({
  id: "msg_rpt_1",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "receipt" }],
  usage: { input_tokens: 150, output_tokens: 90 },
});

async function post(app: Hono, body: unknown) {
  return app.request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pru-agent": "report-agent",
      "x-pru-project": "report-project",
    },
    body: JSON.stringify(body),
  });
}

function seedDb() {
  const db = openLedger(":memory:");
  const fetchImpl: FetchLike = (async () =>
    new Response(JSON_UPSTREAM_BODY, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as FetchLike;
  const { app } = createRelay({
    db,
    upstreamBaseUrl: "https://api.anthropic.com",
    upstreamApiKey: "sk-test",
    fetchImpl,
  });
  return { db, app };
}

describe("receipt figures equal the ledger", () => {
  test("spend, caps, refusals, nights, tallies all render truthfully", async () => {
    const { db, app } = seedDb();
    setCap(db, "global", "*", usdToMicro(10));
    const ok = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "book this" }],
    });
    expect(ok.status).toBe(200);
    await ok.text();
    setCap(db, "global", "*", usdToMicro(0.001));
    const no = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "book this" }],
    });
    expect(no.status).toBe(429);
    await no.text();
    recordTally(db, "night_discount", 21000, "nj_test: batched wholesale");
    queueNightJob(db, {
      projectPath: "/repo",
      repoSnapshot: "/tmp/x.bundle",
      baseSha: "abc123",
      taskPrompt: 'Fix <b>quotes</b> & "things"',
      model: "claude-sonnet-4-5",
      estCostMicro: 21000,
      estStandardMicro: 42000,
    });

    const html = buildReportHtml(db);
    // Same queries, different clothes: 1 posted call at 150/90 sonnet.
    expect(html).toContain("$0.0018");
    expect(html).toContain("Pru closed the ledger for this session");
    expect(html).toContain("night_discount");
    expect(html).toContain("$0.02");
    // Hostile strings escaped, never raw.
    expect(html).not.toContain("<b>quotes</b>");
    expect(html).toContain("&lt;b&gt;quotes&lt;/b&gt;");
    expect(html).toContain("&amp;");
    db.close();
  });

  test("no remote assets: file:// safe by construction", async () => {
    const { db, app } = seedDb();
    const res = await post(app, {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
    });
    await res.text();
    const html = buildReportHtml(db);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).not.toMatch(/src="http/i);
    expect(html).not.toMatch(/href="http/i);
    expect(html).not.toMatch(/url\(http/i);
    db.close();
  });
});
