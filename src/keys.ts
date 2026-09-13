// Upstream credentials (K1): system keychain first, env fallback.
// The secret lives in exactly one OS-guarded place. Pru reads it at boot;
// logs, DB, and error bodies must never contain it (canary-tested).

import { execFileSync } from "node:child_process";

export const KEYCHAIN_SERVICE = "cli.prudence.upstream";
export type KeyAccount = "anthropic" | "openai";

function securityAvailable(): boolean {
  if (process.env.PRU_KEYCHAIN === "off") return false;
  try {
    execFileSync("security", ["-h"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function getKeychainKey(account: KeyAccount): string | null {
  if (!securityAvailable()) return null;
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out ? out : null;
  } catch {
    // Missing entry, denied access, locked keychain — all mean "no key",
    // never an exception the caller must handle.
    return null;
  }
}

export function setKeychainKey(account: KeyAccount, key: string): boolean {
  if (!securityAvailable()) return false;
  try {
    try {
      execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account], {
        stdio: "ignore",
      });
    } catch {
      // No previous entry; nothing to clear.
    }
    execFileSync(
      "security",
      ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", key],
      { stdio: "ignore" },
    );
    return getKeychainKey(account) === key;
  } catch {
    return false;
  }
}

export function deleteKeychainKey(account: KeyAccount): boolean {
  if (!securityAvailable()) return false;
  try {
    execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// Resolution order (pinned by tests): explicit PRU_UPSTREAM_API_KEY first
// (escape hatch), then the keychain, then legacy bare env. Dogfood-safe:
// with no keychain entries this reduces exactly to the old behavior.
export function resolveUpstreamKey(): string | undefined {
  return (
    process.env.PRU_UPSTREAM_API_KEY ??
    getKeychainKey("anthropic") ??
    getKeychainKey("openai") ??
    process.env.ANTHROPIC_API_KEY ??
    process.env.OPENAI_API_KEY ??
    undefined
  );
}
