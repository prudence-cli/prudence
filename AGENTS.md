# AGENTS.md — Prudence ("pru")

Read `implementation-plans-prudence.md` first — it is the source of truth,
**including §0 (competitive landscape)**. This file defines conventions so
every session starts cold without re-deriving decisions.

## Mission

Build **Prudence**: a local LLM gateway daemon (`localhost:8787`, binary
`pru`) that intercepts agent traffic (Claude Code via `ANTHROPIC_BASE_URL`,
Codex/OpenAI-compat via `OPENAI_BASE_URL`). Pru is the **cost-optimization
layer for AI agents** — not merely a firewall, not a scheduler. The moat is
the bundle: request-path enforcement (Meter Watch) + compression + 50%-off
batch execution (Graveyard Shift) + a savings ledger (Tallies).

Product order: Meter Watch first; Graveyard Shift second.

**Positioning rule:** all user-facing text frames value as *savings*, not
surveillance. Night features must always carry the batch discount — never
"just run it at night"; it's "run it at half price."

## Identity and verified assets (fixed facts — do not change)

- Product: **Prudence** · CLI binary: `pru`
- npm: `prudence-cli` (primary) · `pru-cli` (alias) — both claimed
- **Never reference the `@pru` scope — taken by a dormant third party**
- Repo: `github.com/prudence-cli/prudence` — **private until F4**; flip
  public + LICENSE (MIT vs BSL, owner's call) at launch
- Install UX target: `curl -fsSL prudence.sh/install.sh | sh` (domain
  purchase is pending — do not print this URL in shipped/committed user-facing
  artifacts until the owner confirms registration)

## Voice (generate on-brand copy by default)

- Pru is a meticulous, calm, slightly stern bookkeeper. First person.
- Canonical strings (reuse exactly):
  - Budget exhausted: `Pru closed the ledger for this session ($X.XX spent).`
  - Loop guard: `Pru noticed circular spending: same call N× ($Y.YY).`
  - Savings: `Pru set aside $X.XX last night.`
  - Compression: `Pru trimmed N tokens of noise before billing.`
- Banned: emoji in error paths, exclamation marks, apologetic/cutesy tone,
  the word "oops".
- Naming map: firewall → Meter Watch · night batch → Graveyard Shift ·
  savings → Tallies · history → the Ledger.

## Competitive guardrails (from plan §0 — read it first)

- **Runcap** (`kirder24-code/ai-agent-manager`, MIT) ships: local gateway,
  request-path hard caps, pre-flight estimation, **token compression**,
  **Proof Gate** PR verification. Parity on caps+estimation+compression is
  mandatory. Its MIT license permits studying/reusing its techniques — in F1,
  clone and study its source for base-URL interception, estimation edge cases,
  and session detection; add a NOTICE attribution.
- ccusage/usage-monitors are read-only — never ship a monitoring-only feature
  and call it value.
- Anthropic Routines / Dreamer own night *scheduling* — our night feature
  exists ONLY as batch-priced execution. If a night feature can't show the
  50% savings math, redesign it.
- Standing rule: before implementing any new feature, verify against §0 that
  it doesn't collapse into an incumbent; log the conclusion in PROGRESS.md.

## Hard conventions (do not deviate without asking)

- TypeScript on **Bun**; HTTP via **Hono**; DB **SQLite** via
  `bun:sqlite` (built-in; `better-sqlite3` chosen originally but its native
  binding does not load under Bun 1.3 — swapped F2, owner-approved);
  config YAML at `~/.prudence/config.yaml`; ledger DB at
  `~/.prudence/ledger.db`.
- **Money math in integer micro-USD** (1 USD = 1_000_000 units). Floats only
  at display boundaries.
- **All budget mutations inside SQLite transactions.** Reservation →
  reconciliation is one atomic lifecycle; partial states are bugs.
- **Never buffer SSE.** Forward each event immediately; parse on a parallel
  tap. If parsing lags, parsing degrades — the stream never does.
- **Transparent by default**: with no rules configured, behavior is
  byte-identical passthrough.
- **Compression must be conservative and provable**: strip-list only (logs,
  stack traces, repeated JSON), `min_save_tokens` threshold, off-switch per
  rule, unit tests proving no semantic damage via echo-mock.
- **Local-first, zero telemetry** unless explicitly opt-in.
- Schema lives in §1.3 of the plan doc. Migrations as numbered SQL files.

## Repo layout

```
src/
  relay/       # Hono app, guard txn, SSE tap, LOUD 429s
  ledger/      # sqlite layer, migrations, pricing, txn helpers
  compress/    # token-compression pass, F3.5 (parity vs Runcap)
  graveyard/   # product 2 (later): snapshotter, diff_builder, batch_client
  cli.ts       # `pru` commands (commander)
packs/
  claude-code/commands/  # /pru:* slash pack (thin glue; daemon owns truth)
  codex/                 # AGENTS.md engraving snippet
tests/
  fixtures/    # recorded SSE streams + requests
  *.test.ts
docs/          # runcap-study, relay-design (F1 build contracts)
install.sh
NOTICE           # third-party attributions (incl. Runcap study notes)
```

## Testing rules (critical for agent verification)

- **Never call a real LLM API in tests.** Mock upstreams replay SSE fixtures.
- Fixtures: capture real agent traffic early (record one live Claude Code
  session, anonymize, commit). Every rules-engine test replays fixtures.
- Phase DONE = acceptance criteria pass (plan §2.6/§3.6) **and** `bun test`
  green **and** smoke note in PROGRESS.md.
- Mid-stream abort test is mandatory: kill client connection during fixture
  replay → DB consistent, reservation released, row marked `aborted`.

## Current task

See `PROGRESS.md` → "NEXT". Resume from there; do not restart completed
phases. (**F0 — human test-drive of Runcap — precedes F1 and is owner-done.**)

## Progress log

Update `PROGRESS.md` every session: what was built, which acceptance
criterion was verified, how, what is NEXT.

## Explicit non-goals (do not build until told)

- A competing agent harness. Pru runs **inside** Claude Code / Codex, not
  beside them: the relay underneath, the slash pack + MCP + hooks in their
  pane. The `pru` CLI stays a control-plane (install, budget, pace,
  compress, status, shell, start, demo, graveyard, tallies, setup,
  report)
  — any feature that needs its own screen ships inside the harnesses instead.
- Hosted/team features, dashboards, billing, auth
- Ollama / hybrid local routing
- Sponsored moments plugin
- Phase-2 headless graveyard containers
