// K1: credential resolution without ever touching a real keychain.
// Real keychain writes stay manual (`pru setup`); tests pin the order,
// the fallbacks, and the negative (no secret anywhere it shouldn't be).

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveUpstreamKey, getKeychainKey, KEYCHAIN_SERVICE } from "../src/keys";
import { createRelay, type FetchLike } from "../src/relay/server";
import { openLedger, setCap, usdToMicro } from "../src/ledger/db";

const KEEP = { ...process.env };

function scrubEnv() {
  delete process.env.PRU_UPSTREAM_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.PRU_KEYCHAIN = "off";
}

beforeEach(scrubEnv);
afterEach(() => {
  process.env = { ...KEEP };
});

describe("key resolution order", () => {
  test("explicit PRU_UPSTREAM_API_KEY wins over everything", () => {
    process.env.PRU_UPSTREAM_API_KEY = "sk-explicit";
    process.env.ANTHROPIC_API_KEY = "sk-legacy";
    expect(resolveUpstreamKey()).toBe("sk-explicit");
  });

  test("legacy env still resolves with no keychain", () => {
    process.env.ANTHROPIC_API_KEY = "sk-legacy";
    expect(resolveUpstreamKey()).toBe("sk-legacy");
  });

  test("nothing configured resolves to undefined (fail closed)", () => {
    expect(resolveUpstreamKey()).toBeUndefined();
  });

  test("keychain stays untouched when disabled", () => {
    // Would throw or prompt on a machine without `security`; off means off.
    expect(getKeychainKey("anthropic")).toBeNull();
  });
});

describe("keychain hygiene", () => {
  test("service name is namespaced, never generic", () => {
    expect(KEYCHAIN_SERVICE).toContain("prudence");
    expect(KEYCHAIN_SERVICE).not.toBe("api-key");
  });

  test("canary: configured secrets never land in the ledger files", async () => {
    const canary = "sk-canary-9f8e7d6c5b4a";
    process.env.ANTHROPIC_API_KEY = canary;
    const dir = mkdtempSync(join(tmpdir(), "pru-canary-"));
    try {
      const dbPath = join(dir, "ledger.db");
      const db = openLedger(dbPath);
      setCap(db, "global", "*", usdToMicro(0.001));
      const { app } = createRelay({
        db,
        upstreamBaseUrl: "https://api.anthropic.com",
        upstreamApiKey: canary,
        fetchImpl: (async () => {
          throw new Error("must not be called past a blown cap");
        }) as FetchLike,
      });
      const res = await app.request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(429);
      const bodyText = await res.text();
      expect(bodyText).not.toContain(canary);
      db.close();
      // Raw bytes, every ledger sidecar: the secret must appear nowhere.
      for (const f of ["ledger.db", "ledger.db-wal", "ledger.db-shm", "ledger.db-journal"]) {
        const p = join(dir, f);
        if (existsSync(p)) expect(readFileSync(p, "latin1")).not.toContain(canary);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
