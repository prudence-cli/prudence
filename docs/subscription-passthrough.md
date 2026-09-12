# Subscription passthrough mode (spec, pre-implementation)

Date: 2026-09-11. Status: design only — no code.
Question answered: how do Claude Pro/Max and Codex/Plus subscribers
(OAuth tokens, no API keys) get Meter Watch + Graveyard without Pru
ever owning, logging, or interpreting their credentials?

## 0. §0 check (standing rule)

Runcap and AgentKavach both require caller keys; LiteLLM/Portkey are
key-brokers by design. Nobody meters credential-passthrough traffic as
a local product. Verdict: differentiate (no parity debt), proceed.

## 1. Goal

A subscriber points Claude Code at Pru exactly like an API user. Pru
enforces, compresses, and books — but authenticates as *them*, forwarding
their `Authorization` header value byte-identical to the upstream.

Non-goals: holding or refreshing OAuth tokens (the harness keeps doing
that); per-dollar accounting where no dollars exist; the Nut plane
(cheapest-route arbitrage stays brainstorming).

## 2. The one hard rule

**No silent credential forwarding.** Today's fail-closed default stands:
without an explicit opt-in, a keyless route still 429s. Passthrough is
armed per upstream in config:

```yaml
upstreams:
  anthropic:
    auth_mode: passthrough   # default: key
```

Flipping it is the user saying "spend *my* subscription through Pru's
meter." Nothing forwards on ambiguity.

## 3. Header policy

Forward verbatim: `Authorization` (exact value, never parsed — Pru does
not care whether it is `Bearer` OAuth or anything else Anthropic or
OpenAI accept tomorrow), plus the existing feature headers
(`anthropic-beta`, versions, org/project headers).

Never forwarded, never stored, never logged: nothing changes about what
Pru *keeps*. Concretely: no `Authorization` value in `usage_ledger`,
`refusal_events`, daemon stdout, or error bodies. Logs carry
`auth: passthrough (redacted)` at most. A test asserts the substring
never lands in the DB (write a canary value, grep the file).

## 4. Ledger semantics without dollars

- `cost_micro_usd` stays NULL-able truthfully: unknown means unknown
  (`unknown_price` rows already exist for this).
- Enforcement moves to units that exist: caps gain `unit` —
  `calls | input_tokens | usd`. A subscriber arms
  `pru budget set 200 --unit calls` or `--unit input_tokens`.
  Reservation math is unchanged (tokens estimated as today; calls
  counted as 1).
- Estimator: token counts as today; dollar fields NULL.
- Compression: unchanged and *more* valuable — every trimmed token is
  weekly-budget headroom, not cents.
- Tallies: `amount_micro_usd` NULL-able + `amount_tokens INTEGER`;
  `night_discount` books tokens when dollars are unknown.

## 5. The 429 story without dollars

Canonical strings are locked; these are *additions*, same voice:

- Calls exhausted: `Pru closed the ledger for this session (N calls).`
- Tokens exhausted: `Pru closed the ledger for this session (N tokens).`
- Loop/pacing/key messages: unchanged (they never named dollars).

Resume hints name the unit back: `pru budget set 300 --unit calls`.

## 6. Graveyard interaction

Batch API bills per-token at 50% — but a *subscription* has no Batch
API behind it. Night jobs for passthrough sessions refuse at queue
time with a plain message (`Pru cannot batch a subscription session —
batches bill an API key.`), unless a key is configured, in which case
that job runs keyed. No silent fallback to retail.

## 7. Acceptance criteria

1. Mock upstream asserts the exact `Authorization` value arrived and
   the DB file contains no trace of it (canary test).
2. Cap `200 --unit calls` → 201st call 429s with the calls-exhausted
   string; overshoot ≤ 1 call.
3. Unpriced-token enforcement: token-unit cap on unknown model still
   estimates tokens (never prices dollars).
4. No `auth_mode` configured + no key → today's `key_missing` 429,
   unchanged (fail-closed preserved).
5. `bun run check` green; fixtures replay with a passthrough header set.

## 8. Open questions

- Do subscription upstreams accept the same base-URL override cleanly,
  or do harness internals bypass it more aggressively than API mode?
  (Coverage doc gets a passthrough section after the first live run.)
- Should `pru install` detect a subscription harness and *offer*
  passthrough, or stay silent? Leaning: offer, never default.
