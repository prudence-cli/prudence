# PRU PROGRESS FILE — v1.0
**The Living Audit| This file holds Prudence's state between sessions. An agent (or Ronny) reading this file cold should be able to resume work within five minutes. Updated: 2026-09-11 (Day 1 — Field Day)**

---

## 1. THE THESIS

**Prudence (Pru)** — privacy-first desktop AI budgeting app + agent framework. Agents run dry (money, tokens, tool calls) or go rogue; nobody watches. Pru watches everything and answers one question everything else dodges: **"How much did that just cost me — and should it have run at all?"**

Birds are their own accountants. Pru has hers open from token zero. 🐦

### Three planes (deliberate duality)
| Plane | What it is | Status |
|---|---|---|
| **1: App** | Prudence cost/budget control for agent sessions (INV-001) | scaffolded, no backend |
| **2: Harness** | Pru agent framework — own CLI/TUI, own runtime, sessions native | concept + competitive evidence |
| **3: Nut 🌰** | Financial-network moat — find cheapest Claude Subscription Max/Business usage routes for customers (INV-002, Q6 open) | brainstorming, NOT SPECCED |

Plane 3 is the reason this project is attempted rather than merely made.

---

## 2. HARD BOILERS (unchanged — engraved)

1. KISS+t | 2. Simplest code | 3. No backward-compat hoarding — break UI, change API, keep PRU 5% brain, budget remaining cognition for architecture/systems; personality system at most once/day
4. **<=5 changes/PR; LINEAR ISSUES MUST BE DONE AND PR MERGED** (Linear only when sync pilot exists; GitHub Projects until then) | 5. Style defined at scaffold time; zsh: dont check nothing you know was good
6. **TO-DO barriers with named owners — never anonymous** | 7. Project Vandalism = point of no return | 8. Coding agent runs PRU code EVERY TIME | 9. Human+ledger decide enforcement, not the agent | 10. Sessions start empty, never inherit spend | 11. Ledgers before routing logic | 12.yman approval for sideways/Noct until demo
13. Never rebuild OpenCode — celebrate it; abstraction leaks = alert | 14. **Perfection is a lie; shipped imperfection with honest ledger is truth** | 15. Ignore similar solutions until proving Prudence 1% cheaper
16. Explicit terminals > freewheeling — Pru PAUSES at first meaningful Fiat money event | 17. Strategy through contradiction: public receipts | 18. Sudden-protocol sections in AGENTS.md style guide active from repo init
19. Dev landing page exists from day one (prudence.money, dark crow + copper palette) | 20. nut = thinking out loud only until real spec | 21. Agents get USD ceilings + hard stop + residual bucket; per-agent Leaky Bucket: session can refuse; decisions audited
22. Agents switch models only by pointer class. visible reason | 23. Branch:codex/* only; no PR without human+bill awareness | 24. **Pru never hangs — every refusal is loud, instant, explains itself** (engraved 9/11/26 Field Day)
25. **Refusals are typed events, not exit codes** — every surface renders from the same ledger row (engraved 9/11/26)

> Codenames: birds food || accounting things || dead comedian mimes. NO BEE PRODUCTS. NO EVIL BIRDS. NO GRAY PLUMAGE BIRDS. Pru is a crow. Voice: flat, precise, faintly amused, drops ledger lines when pressed.

---

## 3. LEGAL / STRATEGY STATUS

- **ByteDance "Prudence" US TM research**: serial 79309161 in *IC 042 (SaaS component-heavy buying)*, status **DEAD as of 2024** → green
- **OLSHAN LLP "PRUDENCE"** (IC 036, online financial trading platform): **LIVE** → distinguish by market (agent-budget ledger for AI desktop app ≠ trading platform), keep trademark watch
- **getprudence.ai**: taken (redirects to setstone.work, weak/dormant mark)
- **IC 009 vs IC 036 overlap to resolve**; recommended: filing target *Q4 2026* via agent, **pending legal review**
- BYOK = central legal moat: Prudence never holds customer keys
- Positional defense: data gravity + honesty trumps first-mover; they API-rebind, **we own the accounting the binding produces**
- OS lock **ON SUCCESS ONLY** (solo first, Linear/GitHub sync pilot); public receipts posture → Busker Protocol: perform live features under Moniker

Repo: github.com/ronny-sanchezMerino/Prudence --- **LIVE** ✅ (private; solo until pilot)

---

## 4. ARCHITECTURE (Corey, locked)

```
Stack (battle-tested over flash, except where research says youngest):
- Python 3.8 core (standard, no leaner taken) ┃ shipped V runtime when satisfied
- TUI: textual | Web: Flutter/Dart | DB:
- SQLite+WAL (leads to ClickHouse big-O later) ┃ canonical
  usage_ledger.proto team-use handoff
- macOS dmg signing/notarization: BLOCKER until $99 Apple Dev + Sideways approval
- Day-1 dashboard surfaces: current envelope, fuel, savings-per-session,
  top-3 session cost reasons -- ledger-driven, never projecting beyond truth
- Pru CLI (pru run/sessions/parity) — sessions are owned, never wrapped-around
  foreign agents as primary path (gateway exists as secondary relay for
  other vendors' CLIs, where env interception is their boundary respect)
- Parity check: diff ledger vs fund → pry corruption, structurally impossible
  in-side but audited anyway
Principles: every response carries prudence_id (trace from fund to response,
 not from wrapper hope); agent classification: fast_gate|sensor|reasoner|
 synth_gate|verifier; Current Pointers Database (envelope); per-agent
 Leaky Bucket; v1 push routing to Direct API (subscription relay, later)
```

### v0.1: "Prove ledger accuracy" — CHEAPEST FIRST
- Lands: DB (SQLite), usage_ledger w/ model rates, estimation (alive), enforcement (pause), session state, Current Pointers envelope, CLI skeleton, dashboard invoke
- **Checkpoint: run same session twice, ledger must match -- then enforcement can exist**
- Missing scaffolding shown as PENDING red rows with huge to-do within, each named owner
- Ghost row: "A feature that does not exist is not invisible. It is listed as MISSING with its owner name in red."

### Syllabus (Pru as own auditor)

| Task | What | Status |
|---|---|---|
| **F0 Runcap test-drive** | rival's actual usage caps, LIVE competitor discoveries | ✅ **DONE** |
| F1 Sch study Runcap | extract gateway+estimation internals for rejection/comparison → build passthrough proxy | ⬜ NEXT |
| F2 Relay research | how CLI/Claude Code accepts base URL + handshake shape received -> prudence-serving decisions#353 | ⬜ |
| F3 LiteLLM-vs-raw fingerprint | task metrics for routing policy | ⬜ |
| F4 4-thrash | thrash simulation w/ controlled loop+spend scenarios | ⬜ |
| F5 Wrapper hygiene | thin vs fat boundary (OpenAI, vendor SDKs, BYOK, OAuth) | ⬜ |
| F6 Pricing delta | our vs real usage, drift alarm | ⬜ |

---

## 5. F0 — RUNCAP GAP ANALYSIS (2026-09-11, COMPLETE)

Opponent identity: **Joel Hooks** (egghead founder, Badass courses, solo). Tool: **auroradesign/runcap**, MIT (audit green), live payment setup via runcap.ai/setup, Polar.sh monetized. README core promise: "Detect overspend BEFORE it happens" — gateway blocks pre-call, zero trust posture, 429 + machine-readable facts + stop rules in-agent-usable language.

### ✅ WEAPONS-GRADE (what is true of them)
- **Pre-send enforcement is REAL**: 429 in 1–7 ms, $0 leaked, $0.05/day cap held perfectly against ~18 retry attempts
- `gateway-events.jsonl` is beautiful: structured per-call rows — `spentUsd`, `callEstimateUsd`, `truth: "budget_guard"`, `requestHash`, human-readable error strings (e.g., "Budget would be exceeded by this call: $0 spent + ~$0.160075 this call > cap $0.05")
- Gateway **fail-closes** on missing credentials (refused to proxy unguarded)
- Dashboard is genuinely product-ambitious: savings odometer, Mission Planner (risk estimate → verifiable missions → model tiers → stop rules pre-burn), fuel metaphor, Plan/Route/Prove/Learn narrative onboarding, per-run rescue framing
- UX detail worth stealing: copy-pastable "rescue prompt" — guided next action instead of dead end

### ❌ FATAL (their divot = our map)
1. **The kill is silent**: Claude Code receiving a budget 429 retried ~18× over ~110 s; user perceived a hang with zero output. Their ledger knew exactly why; the user's terminal said nothing.
2. **Information archipelago**: 3 truth stores (missions/, gateway-events.jsonl, budget.json) with zero joins. Dashboard showed f0-kill as "needs rescue — command failed, **no parsed error**" while 18 fully-parsed structured refusals sat 3 files away. "Gateway truth: unknown" and "0 API tokens" with a live ledger present.
3. **Rescue layer sends confident nonsense**: rescue prompt says "inspect the project, return the exact files or config values needed to fix it" — there WAS no project bug; their own wallet blocked the call. Blocks do not reach the manager as typed events.
4. **Their loop detector slept through a loop**: agent retrying identical blocked calls `similarity: 1, repeats: 1` → `looping: false`, repeatedly. Their canary feature missed the canary.
5. **Estimator guesses blind**: 500-word answer estimated $1.61 (Opus) / $0.16 (Haiku) — ~50–100× overshoot. No session context, no stage awareness.
6. **Mission machinery everywhere/no-where**: trivial haiku got mission ID + md + html reports + .runcap/ litter in `~`; the one run that MATTERED (the kill) wrote NO report at all; `.runcap/latest` pointed at stale run.
7. **Cap is opt-in per day-cap**: `no cap set → full passthrough` (warned, not enforced).
8. **False-positive debt**: successful haiku flagged "at_risk (low confidence)" + "check this" — scary labels on success.
9. Wrapper friction: stdin warnings on every interactive invocation; TUI trust dialogs unreadable inside `runcap run` (can't answer them); "git not available"-style warnings on non-repo runs; `/v1/v1/messages` double-prefix path bug.

### 🐦 PRU ANSWERS CODIFIED (from evidence, not vibes)
1. Prudence-429 must be terminal for agents and loud in UI — cooperative key engraved in system prompt: refusal = stop, report, ask human
2. Every refusal writes an obituary: ledger row + session event + dashboard row in the SAME DB transaction, same row ID everywhere
3. Dashboard rule: **no number without a traceable source row; else "insufficient data"** — never decorative horoscope-metrics ("30-70% possible saving")
4. Stage-aware session estimator (search/critique/revise envelopes) beats blind per-call guess
5. Loop detection counts refusal-retries as ground-zero signal — a retry-storm against a refusal IS a loop
6. Sessions native to Pru runtime — no stdin fights, no unreadable dialogs, no home-directory litter
7. Cap default: sessions start empty, always COUNTED even when unlimited; enforcement armed unless explicitly disarmed per session with reason recorded

---

## 6. THE RECEIPTS WALL (Day 1)

Date: **Friday, September 11, 2026**

- [x] `usage_ledger.proto` GitHub Gist updated
- [x] Research dumped: Byadance TM (dead ✅), OLSHAN LLP conflict (IC036 watch), getprudence.ai taken
- [x] Independence Day: Objective specs "OWNED SEPARATION plane" vs Provincial YOURS
- [x] **Repo created**: github.com/ronny-sanchezMerino/Prudence (private) — "The Ledger Opens", STRUCTURE.md, AGENTS.md (sudden-protocols: KISS/JSONL/append-only/WAL/outbox/checkpoints/transactions/style guide), `pip install -e .`
- [x] Dev landing page concept: prudence.money (dark crow + copper, not registered yet)
- [x] Runcap v0.4.8 audited: README → MIT LICENSE → npm install → doctor → baseline run → $0.05 kill test → gateway-events.jsonl forensics → dashboard audit (:8791) → rescue-layer audit
- [x] **Competitive intelligence yielded three engraved Boilers (#24, #25) + Pru Answers Codified list (§5)**
- [x] Thesis today: "Never say no to a business AND —" — rather: Field Day > build day. Rival documented README-to-divot in one afternoon; architecture every claim resolved against receipts.

**Day 1 outcome: ledger open, opponent mapped, rules sharpened. +20% lifetime check rate to nobody's surprise of this project org.** 🪶⚖️

---

## 7. ⏭️ NEXT AGENT ACTION

> **START HERE.** You are resuming Pru. Read §2 Boilers, §4 Architecture, §5 Runcap findings, then execute:

**F1 (from §4 Syllabus): Study Runcap as a source base.**
1. `npm view runcap` → confirm MIT-attached package OK to read (green already)
2. `npm pack runcap` or clone auroradesign/runcap; read gateway + estimator + loop-detector internals
3. Produce `/docs/runcap-study.md` in the Prudence repo: what to adopt, what to reject, what they got wrong that we must not copy (esp. estimator blind-guessing, non-typed refusal propagation, siloed truth stores)
4. Give the repo the raw-material analysis for the **passthrough relay** (secondary path in §4) — how their gateway intercepts `ANTHROPIC_BASE_URL`, how it measures pre/post-call delta, what their JSONL schema would look like as our SQLite `usage_ledger` row
5. Update this file: move F1 to ✅ in syllabus, update §7 to F2
6. One PR, ≤5 changes, owner named in any to-do rows, run PRU code (`pip install -e .` prints the banner) before committing

**Constraints from §4 v0.1 still standing: cheapest-first order; the checkpoint that matters is ledger replay determinism — run same session twice, ledgers must match.**

---
*"The receipt wall is the moat. The ledgers record. I include everything they sell, and the panic they advertise during stall." — Pru* 🐦
