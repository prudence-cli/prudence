#!/usr/bin/env bun
// `pru` — the bookkeeper's CLI. F2 surfaces: budget, status, start.
// F3 surfaces: install, shell, pace. F3.5: compress. F4: demo.

import { Command } from "commander";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCap,
  fmtUsd,
  getStatus,
  listNightJobs,
  openLedger,
  queueNightJob,
  setCap,
  setRule,
  usdToMicro,
} from "./ledger/db";
import { createRelay, type FetchLike } from "./relay/server";
import { snapshotRepo } from "./graveyard/snapshot";
import { buildDiffPayload, estimateNightJob } from "./graveyard/diff_builder";
import type { Hono } from "hono";

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

const compress = program.command("compress").description("Trim noise before billing.");

compress
  .command("on")
  .description("Trim log and JSON noise before billing (default).")
  .action(() => {
    const db = openLedger();
    setRule(
      db,
      "global",
      "*",
      "compression",
      { strip: ["logs", "repeated_json", "stack_traces"], min_save_tokens: 200 },
      1,
    );
    db.close();
    console.log("Pru will trim noise before billing. Disable with: pru compress off.");
  });

compress
  .command("off")
  .description("Forward requests byte-identical (no trimming).")
  .action(() => {
    const db = openLedger();
    setRule(db, "global", "*", "compression", {}, 0);
    db.close();
    console.log("Pru forwards byte-identical. Re-enable with: pru compress on.");
  });

program
  .command("demo")
  .description("The 60-second story: fake spend, loud refusal, replay verify, report.")
  .action(async () => {
    // Everything below runs in-process against throwaway file DBs and a
    // stub upstream. No keys, no network, no trace left behind.
    const stubUpstream: FetchLike = async () =>
      new Response(
        JSON.stringify({
          id: "msg_demo_1",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "demo" }],
          usage: { input_tokens: 150, output_tokens: 90 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const demoBody = {
      model: "claude-sonnet-4-5",
      max_tokens: 256,
      system: "You are a demo ledger entry.",
      messages: [{ role: "user", content: "Spend a little, then stop me." }],
    };
    const fire = async (app: Hono) => {
      const r = await app.request(
        "http://localhost/v1/messages",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-pru-agent": "demo-agent",
            "x-pru-project": "demo-project",
          },
          body: JSON.stringify(demoBody),
        },
      );
      return { status: r.status, text: await r.text() };
    };

    const runTape = async (dbPath: string) => {
      const db = openLedger(dbPath);
      const { app } = createRelay({
        db,
        upstreamBaseUrl: "https://api.anthropic.com",
        upstreamApiKey: "sk-demo",
        fetchImpl: stubUpstream,
      });
      setCap(db, "global", "*", usdToMicro(0.01));
      const timeline: { status: number; text: string }[] = [];
      for (let i = 0; i < 8; i++) timeline.push(await fire(app));
      const books = db.query(
        "SELECT model, input_tokens, output_tokens, cost_micro_usd, status, truth FROM usage_ledger ORDER BY created_at",
      ).all();
      const refusals = db.query(
        "SELECT type, message FROM refusal_events ORDER BY id",
      ).all() as { type: string; message: string }[];
      db.close();
      return { timeline, books, refusals };
    };

    const dbA = join(tmpdir(), `pru-demo-${Date.now()}-a.db`);
    const dbB = join(tmpdir(), `pru-demo-${Date.now()}-b.db`);
    try {
      console.log("Pru demo: a $0.01 session against a stub upstream.");
      const first = await runTape(dbA);
      const spent = first.books.length;
      console.log(`Fake spend: ${spent} calls posted before the books closed.`);
      const refusal = first.refusals[0];
      console.log(`Loud refusal [${refusal.type}]: ${refusal.message}`);
      const loop = first.refusals.find((r) => r.type === "loop_blocked");
      if (loop) console.log(`Storm guard [loop_blocked]: ${loop.message}`);
      const second = await runTape(dbB);
      const match =
        JSON.stringify(first.books) === JSON.stringify(second.books) &&
        JSON.stringify(first.refusals) === JSON.stringify(second.refusals);
      console.log(match ? "Replay verify: ledgers match." : "Replay verify: LEDGERS DIFFER.");
      const total = (second.books as { cost_micro_usd: number }[]).reduce(
        (s, r) => s + r.cost_micro_usd,
        0,
      );
      console.log(
        `Report: ${second.books.length} calls, ${fmtUsd(total)} posted, ${second.refusals.length} refusals on the books.`,
      );
      if (!match) process.exitCode = 1;
    } finally {
      for (const f of [dbA, dbB]) {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          try { rmSync(`${f}${suffix}`); } catch { /* already gone */ }
        }
      }
    }
  });

const graveyard = program
  .command("graveyard")
  .description("Half-price overnight work (no task lists the queue).")
  .argument("[task...]", "non-urgent task to queue for the night window")
  .option("--model <model>", "model for the night run", "claude-sonnet-4-5")
  .option("--path <path>", "repo to snapshot (default: cwd)")
  .action((task: string[], opts: { model: string; path?: string }) => {
    const db = openLedger();
    try {
      const text = task.join(" ").trim();
      if (!text) {
        const jobs = listNightJobs(db);
        if (jobs.length === 0) {
          console.log("Pru has no night jobs on the books. Queue one: pru graveyard \"add tests to src/payments\"");
          return;
        }
        for (const j of jobs) {
          console.log(
            `${j.id} [${j.status}] ${j.model} est ${j.est_cost_micro_usd !== null ? fmtUsd(j.est_cost_micro_usd) : "unknown"} — ${j.task_prompt.slice(0, 80)}`,
          );
        }
        return;
      }
      const projectPath = opts.path ?? process.cwd();
      const snap = snapshotRepo(projectPath);
      const payload = buildDiffPayload(snap, text, opts.model);
      const est = estimateNightJob(payload);
      if (!est) {
        console.error(`Pru cannot price model "${opts.model}" — refusing to queue a guess.`);
        process.exitCode = 1;
        return;
      }
      const job = queueNightJob(db, {
        projectPath: snap.project_path,
        repoSnapshot: snap.bundle_path,
        baseSha: snap.base_sha,
        taskPrompt: text,
        model: opts.model,
        estCostMicro: est.batch_micro_usd,
      });
      console.log(`Pru queued night job ${job.id} for ${snap.project_path} @ ${snap.base_sha.slice(0, 8)}.`);
      console.log(
        `Context: ${snap.files.length} files, ~${payload.input_tokens_est.toLocaleString()} tokens` +
          (snap.truncated ? " (truncated at cap)" : "") + ".",
      );
      console.log(
        `Estimate: ${fmtUsd(est.batch_micro_usd)} at batch price vs ${fmtUsd(est.standard_micro_usd)} standard — ` +
          `about ${fmtUsd(est.saved_micro_usd)} stays in your pocket. Runs in the night window; watch with: pru graveyard list.`,
      );
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  });

program.parse();
