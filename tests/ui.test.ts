// UI ornament contract: plain off-TTY (packs, pipes, tests), dressed on TTY.
import { describe, expect, test } from "bun:test";
import { coinBar, crowLine, CROW } from "../src/cli/ui";

describe("terminal character", () => {
  test("crow exists and stays home off-TTY", () => {
    expect(CROW).toContain("(o)>");
    expect(process.stdout.isTTY ?? false).toBe(false);
    expect(crowLine()).toBe("");
  });

  test("coin bar is exact figures plus ornament, never emoji", () => {
    const bar = coinBar(5_000_000, 10_000_000, 10);
    expect(bar).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(bar.replace(/\x1b\[[0-9;]*m/g, "")).toBe("█████░░░░░");
  });

  test("zero limit never divides", () => {
    expect(coinBar(5, 0, 4).replace(/\x1b\[[0-9;]*m/g, "")).toBe("░░░░");
  });
});
