# Runcap source study (F1)

Source: `runcap@0.6.0` npm tarball (33 files), MIT. Upstream repo:
`github.com/kirder24-code/ai-agent-manager`. Study date: 2026-09-11.
Studied files: `bin/runcap.mjs`, `src/mission-control.mjs` (2843 lines,
gateway + ledger + pricing), `src/compressor.mjs` (504 lines, compression +
loop detection), `src/policy.mjs` (verdict grading), `package.json`, `README.md`.

MIT permits studying and reusing techniques with attribution. Attribution
lands in `NOTICE` (this commit). No Runcap code is vendored into Pru.

## 1. How their gateway hijacks base URLs

- Node `http` server. Routes: `POST /v1/*` + `GET /health`. Default port
  8792 (dashboard is 8791).
- Two interception modes:
  1. **Wrapped run** (`runcap run -- <cmd>`): `startEphemeralGateway`
     listens on port 0, pins upstream from the *current* env
     (`AIM_UPSTREAM_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`,
     `AIM_UPSTREAM_BASE_URL` / `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`),
     then rewrites the child env to
     `ANTHROPIC_BASE_URL=<gw>/v1`, `OPENAI_BASE_URL=<gw>/v1`,
     `OPENAI_API_BASE=<gw>/v1`. Pin-before-rewrite avoids self-proxy loops.
  2. **Standalone** (`runcap gateway`): user exports base URLs manually.
- Upstream routing per request: path starts with `/v1/messages` →
  Anthropic base + `x-api-key` + `anthropic-version`; else OpenAI base +
  `Authorization: Bearer`. Strips a doubled `/v1` when the upstream base
  already ends in `/v1` (the `/v1/v1` bug F0 saw is fixed in 0.6.0).
- Fail-closed when neither key is set (throws before listen).
- Caps are **opt-in**: `readBudget()` = `AIM_DAILY_BUDGET_USD` env, else
  `.runcap/budget.json`, else null = full passthrough. Window
  (`AIM_BUDGET_WINDOW`): `day` rolling 24h default, `session` since gateway
  start, `all` no reset, or numeric hours.
- **No SSE streaming.** Handler does `await upstreamResponse.text()`,
  then `response.end(responseText)`. Full buffering. No abort path: a
  client Ctrl+C leaves no reconciliation marker.

## 2. Estimation (pre-call) and costing (post-call)

- Pre-call `estimateRequestCost(body)`:
  `promptText = JSON.stringify(messages ?? system ?? input ?? prompt)`,
  `inputTokens = ceil(len / 4)`, `maxOutput = max_tokens ??
  max_completion_tokens ?? max_output_tokens ?? 4096`.
  `estimate = inputTokens * inputRate + maxOutput * outputRate`.
  Unknown model → `{ estimatedUsd: null, truth: "unknown_price" }`.
- This is the F0 fatal-5 blind estimator: JSON envelope overhead counted as
  prompt, worst-case `max_tokens` always assumed. A 500-word task prices at
  $1.61 Opus / $0.16 Haiku, ~50–100x overshoot. Labeled
  `pre_call_estimate_from_request` (honest label, unusable number).
- Post-call `estimateApiCost(usage, model)`: handles OpenAI
  (`prompt_tokens` / `completion_tokens` + `prompt_tokens_details.cached_tokens`)
  and Anthropic (`input_tokens` / `output_tokens` +
  `cache_read_input_tokens`). Price table sourced
  (`official_provider_pricing`, verified 2026-06-01), per-1M rates for
  Anthropic Opus/Sonnet/Haiku, OpenAI gpt-5.x/4.x, DeepSeek. `batch` in the
  model name applies the 0.5 discount. Unknown model → null + `unknown_price`
  (refuses to guess — adopt this honesty).
- Guard check per request: `spent(window) + callEstimate > cap → 429`.
  No reservation: spent is recomputed by scanning the whole JSONL file on
  every request. Concurrent in-flight calls can both pass the check.

## 3. Ledger and truth stores

- Store: `.runcap/` directory. `gateway-events.jsonl` (append-only event
  per request), `budget.json`, `missions/<id>/{mission.json, report.md,
  report.html, stdout.log, stderr.log}`, `plans/`, `outcomes/<id>/receipt.json`,
  `fuel.json`, `.runcap/latest` pointer.
- Event row: `{ at, path, model, status, durationMs, usage, cost
  {estimatedUsd, truth, pricing}, compression {savedTokens, savedChars,
  ...}, loop {looping, repeats, similarity, responseMoved, truth},
  truth ("budget_guard" | "provider_usage" | "mock_provider_usage" |
  "estimated" | "unknown"), guard {spentUsd, callEstimateUsd,
  callEstimateTruth, projectedUsd, capUsd, blockedByThisCall},
  error, requestHash: sha1(bodyText) }`.
- F0 fatal-2 confirmed in source: three stores, zero joins. Summary is
  recomputed by full-file scan (`readGatewaySummary`); per-run attribution
  is by log-position slice (`eventCountBefore`), not by session id. There
  is **no session concept**, no agent attribution, no SQLite, no
  transactions.

## 4. Compression

- `compressRequestBody`: pure Node, no ML deps. Ladder per string field
  (≥200 chars): compact embedded JSON → collapse log runs (head 12 + tail
  8, only if >40 lines and >50% logish) → squeeze whitespace. Then
  cross-message identical-block dedup (sha1 stub, ≥256 chars) and
  near-duplicate delta-encoding (line-overlap ≥0.5, LCS diff, verified
  lossless via `applyLineDiff` round-trip, ≤2500 lines for hot-path
  protection). Savings counted as `savedChars` / `savedTokens = chars/4`,
  labeled `estimated`. Bypass: `AIM_COMPRESS=off`.
- Real win is dedup of re-reads (their example: 1186 → 737 tokens, 37.9%).
  Note: the pre-call estimate runs on the *uncompressed* body, so the guard
  stays pessimistic. Adopt the ladder and the counting; see relay-design
  for the Pru differences (threshold gate, per-call tally row, echo-mock
  proof).

## 5. Loop detection

- `requestShapeText`: concatenated message/system/input text.
  `lineSimilarity`: set-overlap ratio of lines. `detectLoop`: walk up to
  12 prior shapes backward, count trailing turns with similarity ≥0.92;
  flag when repeats ≥3. Response gate: prompts only count when the
  upstream response signature (assistant text + error) is also stuck
  (≥0.92 similar); a moving response breaks the run (convergence ≠ circling).
  Bypass: `AIM_LOOP_DETECT=off`.
- F0 fatal-4 (retry storm → `looping:false`) is explainable: 429-blocked
  calls return before their response slot is filled, leaving empty
  signatures that weaken the gate, and the storm hashes differ per retry
  enough to sit under 0.92. The detector watches *semantic* circling, not
  *refusal* circling. Pru must count refusal-retries as ground-zero loop
  signal (PROGRESS §5 answer 5); Runcap structurally cannot, because
  blocked calls never produce a response signature.

## 6. Adopt / reject / must-not-copy

**Adopt:**
- Pin-upstream-before-rewriting-child-env (self-proxy avoidance).
- `/v1` strip when upstream base already ends in `/v1`.
- Fail-closed on missing keys.
- `truth` labels on every number; `unknown_price` honesty for unpriced models.
- Sourced, versioned price table with verification date.
- Lossless-by-construction compression ladder + saved-token counting.
- Response-gated loop detection (convergence ≠ circling) as one signal.

**Reject (design against):**
- Blind pre-call estimator (JSON overhead + worst-case max_tokens). Pru
  uses envelope context (relay-design §3).
- Opt-in caps. Pru caps are armed by default; unlimited sessions are still
  counted.
- JSONL-scan-per-request accounting with no reservations. Pru uses SQLite
  transactions with pessimistic reservation → reconciliation.
- Full-response buffering. Pru never buffers SSE; tap parses in parallel.
- Silent 429 (`{error, truth, guard}` JSON only). Pru 429 is loud, typed,
  terminal, with rescue command.
- No sessions. Pru sessions are first-class rows; every request joins to one.

**Must-not-copy:**
- Do not copy the siloed truth stores (missions/ + JSONL + budget.json
  with log-position attribution). One SQLite row of truth, rendered by
  every surface.
- Do not copy refusal handling that leaves Claude Code retrying silently.
  Every Pru refusal is a typed `refusal_events` row with a terminal message
  the harness prints once.
- Do not copy Proof Gate / adjudication scope into the Meter Watch. PR
  verification belongs to the Graveyard `safety_net`, not the request path.
- Do not lift copy, fuel metaphor, or dashboard UX. Pru voice is the
  bookkeeper; savings are Tallies.

## 7. §0 re-decision log (standing rule)

Runcap 0.6.0 vs 0.4.8 (F0): gateway path handling fixed, policy/adjudication
(Tier 3) added, loop detector gained the response gate. None of this closes
our moats: still no sessions, no reservations, no streaming, no typed loud
refusals, no savings ledger, no batch-priced execution. Parity list stands
(caps + estimation + compression); differentiation stands (single ledger
row, replay proof, armed-by-default, Tallies, Graveyard Shift). No plan
change.
