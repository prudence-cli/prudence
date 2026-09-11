# Prudence (`pru`)

Pru cuts your agent bill. She sits underneath Claude Code and Codex,
watches every model call settle through her ledger, and closes the books
the moment a session overspends — loudly, with the exact next command.

- **Meter Watch** — hard budget caps in the request path, per-minute pacing,
  circular-spending guard, and noise trimmed before billing.
- **The Ledger** — every call booked in SQLite: posted spend, reservations,
  typed refusals. One row of truth, rendered the same everywhere.
- **Graveyard Shift** *(next)* — non-urgent work at half price through
  batch execution. The spine above is its showcase.

## How it works

```
Claude Code -- ANTHROPIC_BASE_URL=localhost:8787 --> Pru --> Anthropic API
Codex ------- OPENAI_BASE_URL=localhost:8787/v1 ---> Pru --> OpenAI-compat
```

Each call is priced inside its envelope, reserved in one SQLite
transaction, forwarded (SSE passes straight through, never buffered), then
reconciled to provider-reported usage. Over budget, Pru answers 429:

```text
Pru closed the ledger for this session ($5.00 spent).
Resume with: `pru budget set 10` — or relax the watch: `pru budget off`.
```

A refusal means STOP: report the row, ask your human. Hammering a closed
ledger trips the circular-spending guard.

## Install

```sh
./install.sh
# link pru, point Claude Code at the daemon, verify the books
pru start            # daemon on localhost:8787
pru shell -- claude  # run any agent through the meter
```

## The 60-second story

```sh
pru demo
```

Fake spend, loud fake-cap refusal, replay verification, morning-style
report. The whole product before a real key.

## Control plane

| Command | What |
|---|---|
| `pru install [--port]` | Point Claude Code at the daemon |
| `pru start [--port]` | Start the local gateway daemon |
| `pru budget set <usd>` | Arm a cap (session, project, or global) |
| `pru budget off` | Relax the watch (still counted) |
| `pru pace set <usd>` / `pru pace off` | Bound spend per trailing minute |
| `pru compress on` / `pru compress off` | Trim noise before billing, or not |
| `pru status` | Read the ledger for the latest session |
| `pru shell -- <cmd>` | Run anything through the meter |
| `pru demo` | The 60-second story |

Inside the harnesses: `/pru:status` slash pack for Claude Code and an
`AGENTS.md` engraving for Codex live in `packs/`. The daemon owns all
truth; the packs are thin glue.

## Verification

```sh
bun test   # 29 fixture-replay tests, mock upstreams only — never live APIs
```

Design contracts: `docs/relay-design.md`, `docs/runcap-study.md`,
`docs/coverage.md` (including the honest gaps). Progress ledger:
`PROGRESS.md`.

## License

MIT. See `LICENSE`.
