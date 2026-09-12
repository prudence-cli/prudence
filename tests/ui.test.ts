// UI ornament contract: plain off-TTY (packs, pipes, tests), dressed on TTY.
import { describe, expect, test } from "bun:test";
import { coinBar, crowGrandLine, crowLine, CROW, CROW_GRAND } from "../src/cli/ui";

describe("terminal character", () => {
  test("crow exists and stays home off-TTY", () => {
    expect(CROW).toContain("o o");
    expect(CROW_GRAND).toContain("@@@@");
    expect(CROW_GRAND.split("\n").length).toBeGreaterThan(20);
    expect(process.stdout.isTTY ?? false).toBe(false);
    expect(crowLine()).toBe("");
    expect(crowGrandLine()).toBe("");
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
