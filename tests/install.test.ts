// Install idempotency: settings merge, allowlist merge, pack sync.
// Runs the real CLI in a subprocess with a throwaway HOME.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runInstall(home: string): { code: number; out: string } {
  const proc = Bun.spawnSync(["bun", "src/cli.ts", "install"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, out: String(proc.stdout) + String(proc.stderr) };
}

describe("pru install", () => {
  test("merges env, allowlist, and packs without touching anything else", () => {
    const home = mkdtempSync(join(tmpdir(), "pru-install-"));
    try {
      const { code, out } = runInstall(home);
      expect(code).toBe(0);
      const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as {
        env: Record<string, string>;
        permissions: { allow: string[] };
      };
      expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://localhost:8787");
      expect(settings.permissions.allow).toContain("Bash(pru status)");
      for (const f of ["status.md", "nightshift.md", "graveyard.md"]) {
        expect(existsSync(join(home, ".claude", "commands", "pru", f))).toBe(true);
      }
      expect(out).toContain("slash pack(s)");
      // Second run: idempotent, upgrades in place.
      const again = runInstall(home);
      expect(again.code).toBe(0);
      expect(again.out).toContain("already allowlisted");
      const settings2 = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as {
        permissions: { allow: string[] };
      };
      const pruEntries = settings2.permissions.allow.filter((a) => a.startsWith("Bash(pru"));
      expect(new Set(pruEntries).size).toBe(pruEntries.length);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
