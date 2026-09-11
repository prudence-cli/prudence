#!/usr/bin/env bun
// `pru` — the bookkeeper's CLI. F2 surfaces: budget, status, start.
// F3 surfaces: install, shell, pace.

import { Command } from "commander";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearCap,
  fmtUsd,
  getStatus,
  openLedger,
  setCap,
  setRule,
  usdToMicro,
} from "./ledger/db";
import { createRelay } from "./relay/server";

const program = new Command();
program.name("pru").description("Prudence — the cost-optimization layer for AI agents.").version("0.1.0");

const budget = program.command("budget").description("Manage the ledger watch.");

budget
  .command("set")
  .description("Arm a budget cap (USD).")
  .argument("<usd>", "cap amount in USD")
  .option("--scope <scope>", "session | project | global", "global")
  .option("--key <key>", "scope key (session id, project path, or * for global)", "*")
  .action((usd: string, opts: { scope: string; key: string }) => {
    const value = Number(usd);
    if (!Number.isFinite(value) || value <= 0) {
      console.error("Pru needs a positive USD amount.");
      process.exitCode = 1;
      return;
    }
    const db = openLedger();
    setCap(db, opts.scope, opts.key, usdToMicro(value));
    db.close();
    console.log(`Pru is watching: ${fmtUsd(usdToMicro(value))} cap armed on ${opts.scope}:${opts.key}.`);
  });

budget
  .command("off")
  .description("Relax the watch (remove the global cap).")
  .action(() => {
    const db = openLedger();
    const removed = clearCap(db, "global", "*");
    db.close();
    console.log(removed ? "Pru stood down: global cap removed. Sessions are still counted." : "Pru notes: no global cap was armed.");
  });

program
  .command("status")
  .description("Read the ledger for the latest session.")
  .option("--session <id>", "session id")
  .action((opts: { session?: string }) => {
    const db = openLedger();
    const view = getStatus(db, opts.session);
    db.close();
    if (!view) {
      console.log("Pru has no sessions on the books yet.");
      return;
    }
    const lines = [
      `Session: ${view.session.id} (${view.session.agent}, ${view.session.project_path})`,
      `Calls on the books: ${view.calls}, posted spend: ${fmtUsd(view.spent_micro_usd)}`,
    ];
    for (const cap of view.caps) {
      lines.push(
        `Cap ${cap.scope}:${cap.scope_key}: ${fmtUsd(cap.spent_micro_usd)} spent of ${fmtUsd(cap.limit_micro_usd)}` +
          (cap.reserved_micro_usd > 0 ? ` (${fmtUsd(cap.reserved_micro_usd)} reserved in flight)` : ""),
      );
    }
    for (const r of view.refusals) {
      lines.push(`Refusal #${r.id} [${r.type}]: ${r.message}`);
    }
    console.log(lines.join("\n"));
  });

program
  .command("start")
  .description("Start the local gateway daemon.")
  .option("--port <port>", "listen port", "8787")
  .action((opts: { port: string }) => {
    const port = Number(opts.port);
    if (!Number.isFinite(port) || port <= 0) {
      console.error("Pru needs a valid port.");
      process.exitCode = 1;
      return;
    }
    const upstreamBase =
      process.env.PRU_UPSTREAM_BASE_URL ?? "https://api.anthropic.com";
    const apiKey =
      process.env.PRU_UPSTREAM_API_KEY ??
      process.env.ANTHROPIC_API_KEY ??
      process.env.OPENAI_API_KEY;
    const { app } = createRelay({ upstreamBaseUrl: upstreamBase, upstreamApiKey: apiKey });
    Bun.serve({ port, fetch: app.fetch });
    console.log(`Pru is on the books at http://localhost:${port}. Upstream: ${upstreamBase}.`);
  });

program
  .command("install")
  .description("Point Claude Code at the Pru daemon.")
  .option("--port <port>", "daemon port", "8787")
  .action((opts: { port: string }) => {
    const port = Number(opts.port);
    if (!Number.isFinite(port) || port <= 0) {
      console.error("Pru needs a valid port.");
      process.exitCode = 1;
      return;
    }
    const home = process.env.HOME ?? ".";
    const dir = join(home, ".claude");
    const file = join(dir, "settings.json");
    mkdirSync(dir, { recursive: true });
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (!settings || typeof settings !== "object") settings = {};
    } catch {
      settings = {};
    }
    const env = (settings.env ?? {}) as Record<string, string>;
    settings.env = { ...env, ANTHROPIC_BASE_URL: `http://localhost:${port}` };
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    console.log(`Pru installed: Claude Code traffic now settles through http://localhost:${port}.`);
    console.log(`For Codex and OpenAI-compat tools: export OPENAI_BASE_URL=http://localhost:${port}/v1 — or run: pru shell`);
  });

program
  .command("shell")
  .description("Open a subshell with agent traffic routed through Pru.")
  .argument("[cmd...]", "command to run (default: your login shell)")
  .option("--port <port>", "daemon port", "8787")
  .action(async (cmd: string[], opts: { port: string }) => {
    const port = Number(opts.port);
    if (!Number.isFinite(port) || port <= 0) {
      console.error("Pru needs a valid port.");
      process.exitCode = 1;
      return;
    }
    const base = `http://localhost:${port}`;
    const proc = Bun.spawn(cmd.length ? cmd : [process.env.SHELL ?? "/bin/zsh"], {
      stdio: ["inherit", "inherit", "inherit"],
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: base,
        OPENAI_BASE_URL: `${base}/v1`,
        OPENAI_API_BASE: `${base}/v1`,
      },
    });
    process.exitCode = await proc.exited;
  });

const pace = program.command("pace").description("Bound spend per minute.");

pace
  .command("set")
  .description("Arm a per-minute pace limit (USD/min).")
  .argument("<usd>", "max spend per trailing minute")
  .action((usd: string) => {
    const value = Number(usd);
    if (!Number.isFinite(value) || value <= 0) {
      console.error("Pru needs a positive USD amount.");
      process.exitCode = 1;
      return;
    }
    const db = openLedger();
    setRule(db, "global", "*", "rate_limit", { max_usd_per_minute: value }, 1);
    db.close();
    console.log(`Pru will pace this machine: ${fmtUsd(usdToMicro(value))}/min. Relax with: pru pace off.`);
  });

pace
  .command("off")
  .description("Remove the per-minute pace limit.")
  .action(() => {
    const db = openLedger();
    setRule(db, "global", "*", "rate_limit", {}, 0);
    db.close();
    console.log("Pru lifted the pace limit. Sessions are still counted.");
  });

program.parse();
