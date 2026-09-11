# Pru relay design (F1 → F2 build target)

Companion to `runcap-study.md`. This doc is the build contract for the Meter
Watch request path. Conventions from `AGENTS.md` apply throughout: Bun +
Hono + `better-sqlite3`, money in integer micro-USD, all budget mutations
inside SQLite transactions, never buffer SSE, transparent by default,
local-first zero telemetry, migrations as numbered SQL files.

## (a) Interception and the LOUD 429

### Interception (adopt Runcap pin-before-rewrite, fix the rest)

- Daemon listens on `localhost:8787`. Routes: `POST /v1/messages`
  (Anthropic), `POST /v1/*` (OpenAI-compat), `GET /health`.
- Injection: Claude Code via `ANTHROPIC_BASE_URL=http://localhost:8787`
  in `~/.claude/settings.json`; Codex via
  `OPENAI_BASE_URL=http://localhost:8787/v1`; universal fallback `pru shell`
  spawns a subshell with both set. Upstream pinning copies Runcap: read the
  real `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` + keys from config
  (`~/.prudence/config.yaml`, chmod 600) *before* rewriting, so the
  forwarder proxies to the provider, never to itself. Strip a doubled `/v1`
  when the upstream base already ends in `/v1`.
- Fail-closed when no key is configured for the requested upstream, same as
  Runcap. With no rules configured the relay is byte-identical passthrough
  (transparent by default): no compression, no reservation, only ledger
  append.
- Streaming: forward each SSE event immediately; parse usage on a parallel
  tap. If the tap lags, parsing degrades and the row is flagged
  `degraded_parse`; the stream never waits. This is the structural fix for
  Runcap's `await upstreamResponse.text()` buffering. Mid-stream client
  abort releases the reservation and marks the row `aborted` (F4 test).

### LOUD 429 (the Runcap silent-kill fix)

- Every refusal is a typed `refusal_events` row first, an HTTP response
  second. Types: `budget_exhausted`, `loop_blocked`, `key_missing`,
  `upstream_error`. The daemon terminal, the harness surface
  (`/pru:status`, MCP `ledger_read`), and the HTML `--report` export render
  the *same row id*.
- HTTP shape: `429` with an agent-compatible error body the CLI prints
  once instead of retrying. Body carries: what happened, by how much,
  what to do next, and the exact command:
  `Pru closed the ledger for this session ($5.00 spent). Resume with:
  pru budget set 10 — or relax the watch: pru budget off.`
  (Canonical strings in `AGENTS.md` are reused exactly.)
- Terminal behavior: a refusal ends the spending run. Cooperative rule is
  engraved in the harness packs (`CLAUDE.md` / `AGENTS.md`): a refusal
  means STOP, report the row id, ask the human. Refusal-retries increment
  the loop counter (ground-zero loop signal) instead of re-hitting the
  upstream.
- Caps are armed by default. A session with no explicit limit still gets a
  row, a running total, and a refusal when the default trips. Unlimited
  means counted, not invisible.

## (b) Schema mapping (Runcap JSONL → Pru SQLite)

Pru tables are the PROGRESS §4 rev.2 set: `session`, `usage_ledger`,
`cap_state`, `refusal_events`. (Plan §1.3 names — `sessions`, `requests`,
`ledger_rules`, `night_jobs`, `tallies` — map 1:1 in the table below; the
F2 migration renames to rev.2 and converts all money columns to INTEGER
micro-USD. No REAL money columns ship.)

| Runcap `gateway-events.jsonl` field | Pru column | Notes |
|---|---|---|
| (none — no sessions) | `session.id, agent, project_path, started_at, ended_at, status` | Session created on first request per agent+cwd; all rows join to it. Fixes log-position attribution. |
| `at` | `usage_ledger.created_at`, `refusal_events.created_at` (INTEGER ms epoch) | |
| `path`, `model` | `usage_ledger.upstream, model` | Upstream derived from path (`/v1/messages` → anthropic) as in Runcap. |
| `usage.{prompt_tokens,input_tokens,completion_tokens,output_tokens,cache_read_input_tokens}` | `usage_ledger.input_tokens, output_tokens, cached_tokens` (INTEGER) | Same provider-field handling as Runcap. |
| `cost.estimatedUsd` (float) | `usage_ledger.cost_micro_usd, reserved_micro_usd` (INTEGER) | Reservation at dispatch, reconciled to actual on final usage. Floats only at display. |
| `compression.{savedTokens}` | `usage_ledger.tokens_saved, tally ref` | Savings become a Tallies row (`compression_saving`), not a JSON sub-object. Gated by `min_save_tokens`. |
| `status: 429, truth: budget_guard, guard.{spentUsd, callEstimateUsd, projectedUsd, capUsd, blockedByThisCall}, error` | `refusal_events.{type, spent_micro_usd, cap_micro_usd, call_estimate_micro_usd, message, session_id}` | Typed, joinable, rendered everywhere. `requestHash` becomes `refusal_events.req_hash`. |
| `requestHash` (sha1 of body) | `usage_ledger.req_hash` | Same hash; window default 3 for loop guard. |
| `loop.{looping, repeats, similarity}` | derived, not stored raw | Pru recomputes from ledger + refusal counts; refusal-retries are the primary signal. |
| `durationMs` | `usage_ledger.completed_at - created_at` | |
| `truth` labels | `usage_ledger.truth` TEXT | Keep Runcap honesty: `provider_usage`, `pre_call_estimate_from_request`, `unknown_price`, plus `aborted`, `degraded_parse`. |
| `.runcap/budget.json` + env | `cap_state.{scope, scope_key, limit_micro_usd, spent_micro_usd, reserved_micro_usd}` | One row per scope (session > project > global). Mutated only inside transactions. |
| `missions/`, `outcomes/receipt.json` | out of scope for relay | Belong to Graveyard `safety_net`, not the request path. Must-not-copy stands. |

Migration `001_init.sql` creates the four tables with micro-USD INTEGERs,
`002_plan13_compat.sql` documents the §1.3 → rev.2 rename for reviewers.
Seed pricing table is versioned (`pricing.source`, `pricing.verified`) like
Runcap's, extended with `cached_input` rates.

## (c) Estimate with envelope context

Blind per-call math is rejected (runcap-study §6). The relay prices the
*call inside its envelope*: the session budget, the stage the harness
declared, and what is already reserved.

```ts
type Envelope = {
  session_id: string;
  stage?: string;            // MCP-declared stage; absent in v0.1 (cooperative in v0.2)
  spent_micro_usd: number;   // posted actuals this session
  reserved_micro_usd: number;// in-flight reservations this session
  cap_micro_usd: number | null;
};

type CallShape = {
  model: string;
  input_tokens_est: number;  // measured WITHOUT JSON envelope overhead
  max_output_tokens: number; // caller-declared, else model default (not always 4096)
};

estimateCall(call: CallShape, env: Envelope, pricing: PriceTable):
  | { ok: true; cost_max_micro_usd: number; truth: "envelope_estimate" }
  | { ok: false; truth: "unknown_price"; model: string };
```

Rules:

1. Token measure excludes serialization overhead (message text only, not
   `JSON.stringify` of the envelope). This alone removes most of the
   50–100x overshoot.
2. `cost_max` is pessimistic on output (declared max, else model default)
   but honest on input (measured, minus committed compression savings only
   when the compression rule actually fired for this call).
3. Guard: `spent + reserved + cost_max <= cap`, evaluated and reserved in
   ONE SQLite transaction. Failure inserts the `refusal_events` row in the
   same transaction and returns the LOUD 429. No scan-the-JSONL race.
4. Unknown model → `unknown_price`, fail-closed for capped sessions,
   passthrough with `truth: unknown_price` banner for uncapped sessions
   (never invent a number).
5. Stage awareness is cooperative in v0.1/v0.2 (the harness *declares*
   stages via MCP; the relay does not enforce undeclared ones). Enforcement
   waits until stages are declared; until then the envelope is
   session-spend + reservations.

## (d) Acceptance criteria (PROGRESS §4 v0.1 a–d, mapped to F-phases)

- (a) **Replay determinism** (F1/F2 checkpoint): the same relayed session
  replayed twice against a mock upstream produces byte-identical
  `usage_ledger` rows (ordered by `created_at, id`). Fixture traffic is
  recorded once, anonymized, committed under `tests/fixtures/`.
- (b) **Loud typed 429 reproducible against Claude Code** (F2): mock
  upstream, session cap $0.10 → the over-budget call returns 429 with the
  canonical string, one `refusal_events` row, `spent <= cap + 1
  reservation`, and no silent retry storm (retries increment the loop
  counter).
- (c) **`/pru:status` answers truth from the daemon** (F2/F3): the slash
  pack and MCP `ledger_read` render the same `session` + `cap_state` +
  latest `refusal_events` row id as the daemon terminal.
- (d) **`pru demo` on a cold machine** (F3/F4): 60s scripted fake spend →
  loud fake-cap refusal → replay verify → report, with zero manual config
  after install.
- Mandatory abort test (all phases): kill the client mid-fixture-replay →
  reservation released, row marked `aborted`, `spent + reserved` consistent.

## Build order (F2 next)

F2 implements reservation → reconciliation → ledger close + pricing +
`pru budget/status` against this contract, with mock-upstream fixture
replay. F3 adds loop guard, rate limit, injection, `pru shell`, installer.
F3.5 adds the compression pass with echo-mock no-damage proof. No Graveyard
code rides these PRs; ≤5 changes per PR, named owners per to-do row.
