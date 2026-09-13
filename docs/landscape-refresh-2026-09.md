# Landscape refresh (2026-09-13, web research)

Method: targeted searches + doc reads across agent-cost tooling and both
native harnesses. This supplements §0 (2026-09-11), which stands as the
original record. Rule applied throughout: parity / skip / differentiate.

## 1. Native: what the harnesses now do themselves

### Claude Code / Anthropic (biggest §0 delta)

- **Claude apps gateway spend limits**: first-party self-hosted gateway,
  per-developer daily/weekly/monthly caps, Postgres-backed, OIDC,
  Admin API, live 429s (`billing_error`, `x-should-retry: false`) that
  Claude Code renders verbatim with 75%/95% warnings.
  Verdict: **differentiate**. Enterprise-only, heavy iron, team buyer.
  Nothing for the solo dev with one laptop; no sessions, no
  compression, no savings math, no batch. Our lane (60-second local
  install, SQLite, in-pane) is untouched. Their 429 design converges
  with ours — validation, not threat.
- **Usage credits + monthly spend caps** (Pro/Max), seat allowances
  (Team/Enterprise), workspace spend limits (API orgs), `/usage` +
  `/cost`, `modelPricing` tables.
  Verdict: **parity-partial, differentiate**. Monthly billing rails and
  read-only visibility. Nobody stops an *interactive session* mid-run,
  nobody crosses harnesses, nobody celebrates savings.

### Codex / OpenAI

- **Rollout token budgets** (native, Jun–Jul 2026, opt-in,
  `enabled=false`): shared weighted-token ledger per rollout,
  reminders, graceful turn abort. Token-only, soft boundary,
  Codex-only.
  Verdict: **parity exists natively (opt-in)** — our `--unit tokens`
  is now table stakes on Codex, not differentiation. Dollar story,
  receipts, batch, and hard-stop optionality remain open.
- **No dollar tracking** (RFC #5085 closed unshipped; #29647 complains
  `/usage` is unreadable). Verdict: our core complaint stands.
- **ACP (agenticcontrolplane.com)**: Codex metering proxy with OAuth
  passthrough, API-rate equivalents for subscription dollars,
  workspace daily caps. Closest to our P1 shape from an independent
  direction — validates passthrough, Codex-only, dashboard-flavored.
  Verdict: **differentiate** (multi-harness + batch + tallies + guards).

## 2. The indie enforcement wave (all new since §0)

| Player | Shape | Pru verdict |
|---|---|---|
| LoopBudget | Caps + receipts for teams, but Path A **records** stops, never kills | Differentiate: ours actually stops (in-path 429) + solo-first |
| Terse | Process-level SIGSTOP/SIGTERM breaker, 8 agents, JSONL reading, optimizer | Differentiate: kill-vs-refuse is a philosophy fork; our retry lesson says kills have UX costs too. Their optimizer validates compression parity |
| costfuse (Apache-2.0) | SDK wrapper, 5 rules, audit JSONL, compliance framing, no streaming | Differentiate (wrapper DX vs proxy DX); **steal the compliance language** — our ledger already is an audit trail (EU AI Act era) |
| agent-budget-controller | Library, auto-downgrade, tool filtering | Watch; downgrade idea already in §0 via Tetrate |
| l6e | MCP enforcement + local reroute | Watch; our MCP stays read-only by design |
| Calcis | Estimator + price index w/ changelog + PR blocking | Parity on estimation; **steal the price-feed idea** — versioned feed beats our static table long-term (backlog) |
| AgentCostFirewall (v0.3.0-rc2) | Local OpenAI-compatible proxy, budget blocks, loop scoring, streaming, dashboard | **Closest technically.** Differentiate: Anthropic route, no batch/savings, dashboard vs in-harness |
| UnitCause | Team governance, dashboard, ML anomaly | Different buyer; watch |

Net: **enforcement is now commodity** (6+ credible players). This
confirms the bundle thesis rather than threatening it — parity is
mandatory, winning is elsewhere. Nobody ships batch-priced execution.
Nobody ships savings-as-product. Nobody is in-harness-first.

## 3. Runcap refresh

v0.6.0 steady (matches our source study); live Proof-Gate demo repo
with three adjudicated PRs; ROADMAP + BUSINESS-PLAN docs published but
hosted/team/paid explicitly "not available for purchase." Direction:
verification-depth, not savings breadth. Our moats (batch, tallies,
in-harness voice) unclaimed. Standing decisions unchanged.

## 4. Conclusions (no plan change)

1. Native owns enterprise-teams and monthly rails. Pru owns the solo
   interactive session, cross-harness, and the savings story.
2. Enforcement parity is table stakes; the bundle (batch + tallies +
   in-pane + loud refusals) is the product.
3. Steal queue: compliance language, pricing feed. Rejected: process
   kills, dashboards, hosted custody.
4. Launch positioning sharpens to: *"Everyone else guards your calls
   or bills your team. Pru keeps your books — and cuts the bill in
   half while you sleep."*
