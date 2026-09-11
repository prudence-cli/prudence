# AGENTS.md — Prudence ("pru")

Read `implementation-plans-prudence.md` first — it is the source of truth,
**including §0 (competitive landscape)**. This file defines conventions so
every session starts cold without re-deriving decisions.

## Mission

Build **Prudence**: a local LLM gateway daemon (`localhost:8787`, binary
`pru`) that intercepts agent traffic (Claude Code via `ANTHROPIC_BASE_URL`,
Codex/OpenAI-compat via `OPENAI_BASE_URL`). Pru is the **cost-optimization
layer for AI agents** — not merely a firewall, not a scheduler. The moat is
the bundle: request-path enforcement (Meter Watch) + 50%-off batch execution
(Graveyard Shift) + a savings ledger (Tallies).

Product order: Meter Watch first; Graveyard Shift second.

**Positioning rule:** any user-facing or marketing text must frame value as
*savings*, not surveillance. Scheduling features must always carry the batch
discount — never build "just run it at night"; it's "run it at half price."

## Identity and verified assets (fixed facts — do not change)

- Product: **Prudence** · CLI binary: `pru`
- npm: `prudence-cli` (primary, published 0.0.1 placeholder) · `pru-cli`
  (alias placeholder) · **never reference the `@pru` scope — taken by a
  dormant third party**
- Repo: `github.com/prudence-cli/prudence` — **private until F4 hardening**;
  flip to public + add LICENSE (MIT vs BSL, owner's call) as part of launch
- Install UX target: `curl -fsSL prudence.sh/install.sh | sh`

## Voice (generate on-brand copy by default)

- Pru is a meticulous, calm, slightly stern bookkeeper. First person.
- Canonical strings (reuse exactly):
  - Budget exhausted: `Pru closed the ledger for this session ($X.XX spent).`
  - Loop guard: `Pru noticed circular spending: same call N× ($Y.YY).`
  - Savings: `Pru set aside $X.XX last night.`
- Banned in UX copy: emoji in error paths, exclamation marks, apologetic or
  cutesy tone, the word "oops".
- Naming map: firewall → Meter Watch · night batch → Graveyard Shift ·
  savings → Tallies · history → the Ledger.

## Competitive guardrails (from plan §0)

- Runcap exists: local proxy + hard cap + 429. Parity on caps is mandatory;
  differentiation = loop-guard UX, multi-upstream, tallies.
- ccusage/usage-monitors are read-only — never ship a monitoring-only feature
  and call it value.
- Anthropic Routines / Dreamer own night *scheduling* — our night feature
  exists ONLY as batch-priced execution. If a night feature can't show the
  50% savings, redesign it.
- Standing rule: before implementing any new feature, verify it doesn't
  collapse into an incumbent (plan §0). Log the conclusion in PROGRESS.md.

## Hard conventions (do not deviate without asking)

- TypeScript on **Bun**; HTTP via **Hono**; DB **SQLite** via
  `better-sqlite3`; config YAML at `~/.prudence/config.yaml`; ledger DB at
  `~/.prudence/ledger.db`.
- **Money math in integer micro-USD** (1 USD = 1_000_000 units). Floats only
  at display boundaries.
- **All budget mutations inside SQLite transactions.** Reservation →
  reconciliation is one atomic lifecycle; partial states are bugs.
- **Never buffer SSE.** Forward each event immediately; parse on a parallel
  tap. If parsing lags, parsing degrades — the stream never does.
- **Transparent by default**: with no rules configured, behavior is
  byte-identical passthrough.
- **Local-first, zero telemetry** unless explicitly opt-in.
- Schema lives in §1.3 of the plan doc. Migrations as numbered SQL files.

## Repo layout

```
src/
  server/      # Hono app, route handlers (/v1/messages, /v1/*)
  proxy/       # forwarder, SSE tap, auth replacement
  rules/       # ledger rules engine (budget, rate_limit, loop_guard)
  store/       # sqlite layer, migrations, txn helpers
  pricing/     # price table, estimators
  cli/         # `pru` commands (commander)
  graveyard/   # product 2 (later): snapshotter, diff_builder, batch_client
tests/
  fixtures/    # recorded SSE streams + requests (see Testing)
  *.test.ts
install.sh
```

## Testing rules (critical for agent verification)

- **Never call a real LLM API in tests.** All upstreams mocked: a local mock
  server replaying SSE fixtures from `tests/fixtures/`.
- Fixtures: capture real request/response streams early (record one live
  Claude Code session, anonymize, commit as fixture). Every rules-engine test
  replays fixtures.
- Each phase has acceptance criteria in the plan doc (§2.6, §3.6). A phase is
  DONE only when: acceptance criteria pass **and** `bun test` green **and** a
  manual smoke note is added to `PROGRESS.md`.
- Mid-stream abort test is mandatory: kill client connection during fixture
  replay → DB consistent, reservation released, row marked `aborted`.

## Current task

See `PROGRESS.md` → "NEXT". Resume from there; do not restart completed
phases. (NOTE: phase F0 — human test-drive of Runcap — precedes F1.)

## Progress log

Update `PROGRESS.md` at the end of every session: what was built, which
acceptance criterion was verified, how (test name or manual steps), what is
NEXT.

## Explicit non-goals (do not build until told)

- Hosted/team features, dashboards, billing, auth
- Ollama / hybrid local routing
- Sponsored moments plugin
- Phase-2 headless graveyard containers
