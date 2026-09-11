// F3.5 proof: compression is conservative and provable.
// The mock upstream echoes what it receives, so every byte the relay
// forwards is inspectable: smaller where it counts, identical where it
// matters. Never touches a real LLM API.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compressRequestBody } from "../src/compress/index";
import { createRelay } from "../src/relay/server";
import { openLedger, setCap, setRule, usdToMicro } from "../src/ledger/db";

const FIX = join(import.meta.dir, "fixtures");
const smallFixture = () =>
  JSON.parse(readFileSync(join(FIX, "anthropic-request.json"), "utf8")) as Record<string, unknown>;
const logHeavyFixture = () =>
  JSON.parse(readFileSync(join(FIX, "log-heavy-request.json"), "utf8")) as Record<string, unknown>;

// Echo mock: captures the EXACT bytes the relay forwards, answers canned usage.
function echoUpstream() {
  let captured = "";
  let calls = 0;
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    calls++;
    captured = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        id: "msg_echo_1",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "echo" }],
        usage: { input_tokens: 150, output_tokens: 90 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, captured: () => captured, calls: () => calls };
}

function post(app: { request: typeof fetch }, body: unknown) {
  return (app.request as (input: string, init?: RequestInit) => Promise<Response>)(
    "http://localhost/v1/messages",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pru-agent": "compress-agent",
        "x-pru-project": "compress-project",
      },
      body: JSON.stringify(body),
    },
  );
}

describe("strip ladder (unit)", () => {
  test("pretty JSON compacts and parses back identical", () => {
    const obj = { files: [{ path: "a.ts", lines: 3 }], scanned: 1 };
    const prefix = "Scanner output:\n" + "note ".repeat(30) + "\n";
    const long = prefix + JSON.stringify(obj, null, 2);
    const { body, touched } = compressRequestBody({
      model: "m",
      messages: [{ role: "user", content: long }],
    });
    expect(touched).toBeGreaterThan(0);
    const out = (body.messages as { content: string }[])[0].content;
    expect(out.length).toBeLessThan(long.length);
    // The squeeze pass may trim trailing whitespace, so locate the JSON.
    expect(JSON.parse(out.slice(out.indexOf("{")))).toEqual(obj);
  });

  test("log runs collapse to head + tail + marker; prose never collapses", () => {
    const logs = Array.from(
      { length: 60 },
      (_, i) => `2026-09-11T02:00:${String(i).padStart(2, "0")}Z INFO worker message number ${i}`,
    ).join("\n");
    const prose = Array.from({ length: 60 }, (_, i) => `Consideration the ${i}th: prudence demands receipts.`).join("\n");
    const logged = compressRequestBody({ model: "m", messages: [{ role: "user", content: logs }] });
    expect(logged.touched).toBe(1);
    const collapsed = (logged.body.messages as { content: string }[])[0].content;
    expect(collapsed).toContain("elided by Pru");
    expect(collapsed.split("\n").length).toBeLessThan(30);
    const prosed = compressRequestBody({ model: "m", messages: [{ role: "user", content: prose }] });
    expect((prosed.body.messages as { content: string }[])[0].content).toBe(prose);
  });

  test("small fields and single-line prose pass through untouched", () => {
    const short = "Do the thing, briefly.";
    const { body, savedTokens, touched } = compressRequestBody({
      model: "m",
      system: "Be terse.",
      messages: [{ role: "user", content: short }],
    });
    expect(touched).toBe(0);
    expect(savedTokens).toBe(0);
    expect((body.messages as { content: string }[])[0].content).toBe(short);
  });

  test("identical repeats become stubs; first occurrence stays verbatim", () => {
    const block = "DATA " + "0123456789abcdef ".repeat(30);
    const { body } = compressRequestBody({
      model: "m",
      messages: [
        { role: "user", content: block },
        { role: "user", content: block },
      ],
    });
    const [a, b] = (body.messages as { content: string }[]).map((m) => m.content);
    expect(a).toBe(block);
    expect(b).not.toContain("DATA");
    expect(b).toContain("[pru: identical content seen at message 1, sha:");
  });

  test("strip list is honored", () => {
    const obj = { a: 1 };
    const pretty = JSON.stringify(obj, null, 2) + "\n" + "y".repeat(300);
    const { touched } = compressRequestBody(
      { model: "m", messages: [{ role: "user", content: pretty }] },
      { strip: ["logs"] },
    );
    expect(touched).toBe(0);
  });
});

describe("echo-mock relay proof", () => {
  test("log-heavy prompt shrinks past the threshold and books the savings", async () => {
    const db = openLedger(":memory:");
    const echo = echoUpstream();
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      upstreamApiKey: "sk-test",
      fetchImpl: echo.fetchImpl,
    });
    const fixture = logHeavyFixture();
    const originalText = JSON.stringify(fixture);
    const res = await post(app, fixture);
    expect(res.status).toBe(200);
    await res.text();
    const forwarded = echo.captured();
    const savedChars = originalText.length - forwarded.length;
    expect(savedChars / 4).toBeGreaterThanOrEqual(200);
    const row = db.query("SELECT * FROM usage_ledger").get() as Record<string, unknown>;
    expect(row.tokens_saved as number).toBeGreaterThanOrEqual(200);
    expect(row.tokens_saved).toBe(Math.round(savedChars / 4));

    // Semantics intact: short prose byte-identical, first occurrence verbatim.
    const sent = JSON.parse(forwarded) as typeof fixture;
    expect(sent.system).toBe(fixture.system);
    expect(sent.messages[0]).toEqual(fixture.messages[0]);
    const origMsgs = fixture.messages as { role: string; content: string }[];
    const sentMsgs = sent.messages as { role: string; content: string }[];
    expect(sentMsgs[1].content.split("\n").slice(0, 12).join("\n")).toBe(
      origMsgs[1].content.split("\n").slice(0, 12).join("\n"),
    );
    expect(sentMsgs[1].content).toContain("elided by Pru");
    db.close();
  });

  test("guard stays pessimistic: priced pre-compression, refuses what fits post-hoc", async () => {
    const db = openLedger(":memory:");
    const echo = echoUpstream();
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      upstreamApiKey: "sk-test",
      fetchImpl: echo.fetchImpl,
    });
    // Fixture cost_max ≈ $0.107; actuals would be $0.0018. A $0.05 cap must
    // still refuse — the guard never spends the compression discount.
    setCap(db, "global", "*", usdToMicro(0.05));
    const res = await post(app, logHeavyFixture());
    expect(res.status).toBe(429);
    expect(echo.calls()).toBe(0);
    db.close();
  });

  test("disabled rule means byte-identical passthrough", async () => {
    const db = openLedger(":memory:");
    setRule(db, "global", "*", "compression", {}, 0);
    const echo = echoUpstream();
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      upstreamApiKey: "sk-test",
      fetchImpl: echo.fetchImpl,
    });
    const fixture = logHeavyFixture();
    const res = await post(app, fixture);
    expect(res.status).toBe(200);
    await res.text();
    expect(echo.captured()).toBe(JSON.stringify(fixture));
    const row = db.query("SELECT * FROM usage_ledger").get() as Record<string, unknown>;
    expect(row.tokens_saved).toBe(0);
    db.close();
  });

  test("below-threshold traffic forwards untouched", async () => {
    const db = openLedger(":memory:");
    const echo = echoUpstream();
    const { app } = createRelay({
      db,
      upstreamBaseUrl: "https://api.anthropic.com",
      upstreamApiKey: "sk-test",
      fetchImpl: echo.fetchImpl,
    });
    const fixture = smallFixture();
    const res = await post(app, fixture);
    expect(res.status).toBe(200);
    await res.text();
    expect(echo.captured()).toBe(JSON.stringify(fixture));
    db.close();
  });
});
