# PRU PROGRESS FILE — v2.0
**The Living Audit | This file holds Prudence's state between sessions. An agent (or Ronny) reading this file cold should be able to resume work within five minutes. Updated: 2026-09-11 (Day 1 — Field Day + the Inside-Tools Decision)**

---

## 1. THE THESIS

**Prudence (Pru)** — the accountant that lives **inside** the agent tools people already use (Claude Code, Codex CLI, Cursor). Privacy-first, BYOK, ledger-first. Agents run dry (money, tokens, tool calls) or go rogue; nobody watches. Pru watches everything and answers one question everything else dodges: **"How much did that just cost me — and should it have run at all?"**

Birds are their own accountants. Pru has hers open from token zero. 🐦

### Three planes (revision 2 — locked 2026-09-11 evening)
| Plane | What it is | Status |
|---|---|---|
| **1: Ledger daemon + surfaces** | SQLite bookkeeper + relay + MCP/slash packs living inside Claude Code & Codex | v0.1 target |
| **2: Night Shift** | Headless overnight runs any CLI drives; Pru keeps receipts; morning digest in the harness the user already stares at | flagship story, rides on Plane 1 |
| **3: Nut 🌰** | Financial-network moat — cheapest Claude Subscription Max/Business usage routes (INV-002, Q6 open) | brainstorming, NOT SPECCED |

**Demoted:** own-CLI/TUI agent harness (old Plane 2). Rationale: Boiler 13 (never rebuild OpenCode-by-another-name), KISS+t, founder preference, and the realization that Claude Code/Codex already ARE the UI. Revisit only if hook/MCP APIs prove too leaky (Boiler 13: abstraction leaks = alert).

### Identity pillars (locked)
1. **The crow voice** — flat, precise, faintly amused; ledger lines when pressed. Every competitor sounds like a dashboard; Prudence sounds like an accountant.
2. **Night Shift** — agents fly after dark; the user wakes to a receipt queue: spend to the cent, stops + why, ledger verified badge, crow's one-liners. The overnight silent-death scenario is where Runcap-class wrappers cannot follow.

---

## 2. HARD BOILERS (unchanged — engraved)

1. KISS+t | 2. Simplest code | 3. No backward-compat hoarding — break UI, change API, keep PRU 5% brain, budget remaining cognition for architecture/systems; personality system at most once/day
4. **<=5 changes/PR; LINEAR ISSUES MUST BE DONE AND PR MERGED** (Linear only when sync pilot exists; GitHub Projects until then) | 5. Style defined at scaffold time; zsh: dont check nothing you know was good
6. **TO-DO barriers with named owners — never anonymous** | 7. Project Vandalism = point of no return | 8. Coding agent runs PRU code EVERY TIME | 9. Human+ledger decide enforcement, not the agent | 10. Sessions start empty, never inherit spend | 11. Ledgers before routing logic | 12. Yeman approval for sideways/Noct until demo
13. Never rebuild OpenCode — celebrate it; abstraction leaks = alert | 14. **Perfection is a lie; shipped imperfection with honest ledger is truth** | 15. Ignore similar solutions until proving Prudence 1% cheaper
16. Explicit terminals > freewheeling — Pru PAUSES at first meaningful Fiat money event | 17. Strategy through contradiction: public receipts | 18. Sudden-protocol sections in AGENTS.md style guide active from repo init
19. Dev landing page exists from day one (prudence.money, dark crow + copper palette) | 20. nut = thinking out loud only until real spec | 21. Agents get USD ceilings + hard stop + residual bucket; per-agent Leaky Bucket: session can refuse; decisions audited
22. Agents switch models only by pointer class; visible reason | 23. Branch:codex/* only; no PR without human+bill awareness | 24. **Pru never hangs — every refusal is loud, instant, explains itself** (engraved 9/11/26)
25. **Refusals are typed events, not exit codes** — every surface renders the same ledger row (engraved 9/11/26)

> Codenames: birds food || accounting things || dead comedian mimes. NO BEE PRODUCTS. NO EVIL BIRDS. NO GRAY PLUMAGE BIRDS. Pru is a crow.

---

## 3. LEGAL / STRATEGY STATUS

- **ByteDance "Prudence" US TM research**: serial 79309161 in *IC 042*, status **DEAD as of 2024** → green
- **OLSHAN LLP "PRUDENCE"** (IC 036, online trading platform): **LIVE** → distinguish by market; keep trademark watch
- **getprudence.ai**: taken (redirects to setstone.work, weak/dormant)
- **IC 009 vs IC 036 overlap to resolve**; filing target *Q4 2026*, **pending legal review**
- BYOK = central legal moat: Pru never holds customer keys
- Positional defense: data gravity + honesty > first-mover; they API-rebind, **we own the accounting**
- OS lock **ON SUCCESS ONLY**; public receipts → Busker Protocol: perform live features under Moniker

Repo: github.com/ronny-sanchezMerino/Prudence — **LIVE** ✅ (private; solo until pilot)

---

## 4. ANATOMY (Corey — revision 2, locked 2026-09-11 evening)

```
Pru v0.1 =

 1. LEDGER DAEMON (the product)
    - SQLite + WAL, append-only; schemas: usage_ledger, cap_state, session, refusal_events
    - Append-only JSONL mirrors (audit integrity, ccusage-style familiarity)
    - Replay: same relayed session twice → ledgers must match (v0.1 checkpoint)

 2. RELAY — local reverse proxy (the hard stop)
    - Claude Code via ANTHROPIC_BASE_URL, Codex via OPENAI_BASE_URL
    - Pre-call estimate → budget check → 429-with-typed-reason on breach →
      pass-through + post-call actuals recorded (usage tokens from response)
    - Fail-closed if keys missing; LOUD 429 body designed for the CLI to print
      ("$X spent of $Y/day — continue with: pru cap set day Z")

 3. IN-HARNESS PACK (the voice — where Pru is FELT)
    Claude Code:  .claude/commands/pru:*.md slash pack (/pru:status, /pru:cap,
                  /pru:nightshift, /pru:verify, /pru:report)
                  MCP server (tools: ledger_read, cap_set, envelope_report,
                  nightshift_digest) so the agent can read its own wallet
                  PreToolUse/UserPromptSubmit hooks gate expensive ACTIONS
    Codex CLI:    config.toml MCP entry + AGENTS.md engraving
                  ("Pru wallets are read-only sources of truth; a refusal
                    means STOP, report, ask human")
    Honest limit: slash/MCP = visibility + self-restraint + action gating;
                  ONLY the relay hard-stops the model call itself.

 4. SHELL SURFACES (ours alone)
    - pru doctor (heals: every warn ends with the one next command)
    - pru demo (60s scripted: fake spend → loud fake-cap refusal →
      replay verify → report. The whole product story before a real key)
    - pru nightshift digest (morning receipt queue — Plane 2)

Dropped vs rev.1: textual TUI app, Flutter dashboard, native-agent harness.
Surfaces target: the harness the user already uses + a `--report` HTML export
(one file, ledger-driven, no server). Keep it audit-shaped.

Risk note: in-harness packs are thin glue on others' APIs — monitor for
abstraction leaks (Boiler 13). The daemon owns ALL truth and survives
surface rupture.
```

### Feature map (v0.1 → v0.2 → Night Shift)

| Group | Items | Evidence anchor |
|---|---|---|
| **Spine** | Native-relayed sessions, append-only ledger w/ per-call rows, `pru ledger verify`, armed-by-default caps, Leaky Bucket + residual jar | F0 §5 all; checkpoint = replay match |
| **Guards** | Typed refusals 💰🔁🔑☁️ (same row → every surface), stage-aware estimation (envelope context), loop-detection counting refusal-retries, doctor-that-heals | F0 fatals 1,4,5,8 |
| **Voice layer** | Savings statement per session ("used $0.042 of $0.10; $0.058 to the jar"), MCP wallet-read for agents, `/pru:*` pack, rescue prompts grounded in the refusal record | F0 fatal 3; §5b |
| **Night Shift** (v0.3) | Headless runs (any CLI as runner), morning digest inside harness + HTML export, replay-verified badge | §1 pillars |
| **Deferred** | Own TUI/web dashboard, stage-envelope enforcement (needs MCP-declared stages; v0.2 cooperative mode), pointer-class routing (v1, with Direct API push), Nut plane | — |

v0.1 acceptance: (a) replay determinism, (b) loud typed 429 reproducible against Claude Code, (c) `/pru:status` answers truth from the daemon, (d) `pru demo` runs end-to-end on a cold machine.

### Syllabus (Pru as own auditor)

| Task | What | Status |
|---|---|---|
| **F0 Runcap test-drive** | rival autopsy, LIVE competitor discoveries | ✅ **DONE** |
| F1 Runcap source study → relay design | read gateway+estimator+loop internals; produce /docs/runcap-study.md + /docs/relay-design.md (schema mapping JSONL→SQLite rows, ANTHROPIC_BASE_URL interception mechanics, estimate function spec with envelope context) | ✅ **DONE 2026-09-11** (runcap@0.6.0; 7 files, 4 logical changes — see §7 log) |
| F2 Reservations + ledger close + pricing + `pru budget/status` | Bun/Hono/`bun:sqlite` relay, txn reserve→reconcile, LOUD typed 429, fixture replay + abort tests | ✅ **DONE 2026-09-11** (11 tests green; $0.10 cap → 429, overshoot ≤ 1 reservation — see §7 log) |
| F3 Loop guard + rate limit + injection + installer | refusal-retries loop signal, max USD/min, `pru shell`, fresh-checkout proxied with zero manual config | ✅ **DONE 2026-09-11** (17 tests green; storm → loop_blocked — see §7 log) |
| F3.5 Compression pass | strip-list compression + tallies, echo-mock no-damage proof | ✅ **DONE 2026-09-11** (26 tests green; 38k-token fixture sheds past threshold — see §7 log) |
| F4 Hardening + go public | per-agent fixtures, README, landing, repo public + LICENSE | ✅ **DONE (code) 2026-09-11** (29 tests green; `pru demo` tells the story — owner gates left: LICENSE, public flip, live capture — see §7 log) |
| F5 Meter Watch launch | headline leads with savings | ⬜ NEXT, then N-track (Graveyard) |

---

## 5. F0 — RUNCAP GAP ANALYSIS (2026-09-11, COMPLETE)

Opponent: **Joel Hooks** (egghead founder, solo). Tool: **auroradesign/runcap**, MIT (audit green), Polar.sh monetized via runcap.ai/setup. README: "Detect overspend BEFORE it happens."

### ✅ WEAPONS-GRADE (true of them)
- **Pre-send enforcement REAL**: 429 in 1–7 ms, $0 leaked, $0.05/day cap held against ~18 retries
- `gateway-events.jsonl`: beautiful structured rows (spentUsd, callEstimateUsd, truth:"budget_guard", requestHash, human error strings)
- Fail-closed on missing credentials
- Product-ambitious dashboard: savings odometer, Mission Planner (risk→missions→tiers→stop rules pre-burn), fuel metaphor, Plan/Route/Prove/Learn onboarding
- Worth stealing: copy-pastable rescue prompt mechanism

### ❌ FATAL (their divot = our map)
1. **Silent kill**: Claude Code hit budget-429 → ~18 silent retries over ~110 s; user saw a "hang."
2. **Truth archipelago**: 3 stores (missions/, gateway-events.jsonl, budget.json), zero joins; dashboard showed "no parsed error" beside a full structured ledger.
3. **Rescue = confident nonsense**: "inspect the project, return the files needed to fix it" — the blocker was their own wallet.
4. **Loop detector asleep**: similarity=1 retry storm → looping:false, every time.
5. **Blind estimator**: 500-word task priced $1.61 Opus / $0.16 Haiku (~50–100× overshoot).
6. **Mission litter + no obituary**: haiku got md+html+ID; the kill run got NO report; `.runcap/latest` stale.
7. **Caps opt-in**: `no cap set → full passthrough`.
8. **False positives**: haiku flagged "at_risk" + "check this."
9. Wrapper friction: stdin warnings, unreadable trust dialogs, non-repo WARNs, `/v1/v1/messages` path bug.

### 🐦 PRU ANSWERS CODIFIED
1. Pru-429 is terminal + loud; cooperative refusal rule engraved in CLAUDE.md/AGENTS.md
2. Every refusal = typed row; daemon terminal + harness surface + HTML report render the SAME row ID
3. No number without a traceable source row; else "insufficient data"
4. Envelope-context estimation beats blind per-call math
5. Refusal-retries = ground-zero loop signal
6. In-harness surfaces = no stdin fights, no litter, no unreadable dialogs
7. Caps armed by default; sessions always counted, even when unlimited

---

## 5b. POSITIONING (locked)

**"Runcap guards your calls. Pru keeps the books — and shows you the books."**
Compete on guarding by matching; win on bookkeeping by default. F0 fatals = launch-post bullets with receipts (Boiler 17).

**Competitive (parity):** pre-send stop, structured events, retry-storm-proof caps, fail-closed keys — all matched or exceeded (ours armed-by-default, theirs opt-in).

**Differentiated (they structurally can't):** one row of truth across all surfaces; replay as public proof; honest incapacity ("insufficient data" > horoscopes); the bookkeeper's voice; verifiable savings statements; **residency inside Claude Code/Codex** — we meet the user in their pane.

**Friendlier (week-one felt):** refusal literacy (what/by-how-much/what-next/exact-command); 4-icon taxonomy with zero false positives; doctor-that-heals; armed-by-default never preachy; `pru demo` magic trick on cold install (prudence-cli + pru-cli already on npm @0.0.1).

---

## 6. THE RECEIPTS WALL (Day 1 — 2026-09-11)

- [x] `usage_ledger.proto` Gist updated
- [x] Legal research: ByteDance dead ✅, OLSHAN LLP IC-036 watch, getprudence.ai taken
- [x] Repo live: STRUCTURE.md, AGENTS.md sudden-protocols, `pip install -e .` banner
- [x] prudence-cli + pru-cli on npm @0.0.1 (prior session)
- [x] prudence.money landing concept (dark crow + copper, unregistered)
- [x] Runcap v0.4.8 full autopsy: README → LICENSE → install → doctor → baseline → $0.05 kill test → JSONL forensics → dashboard (:8791) → rescue layer
- [x] Boilers #24–25 engraved from evidence; §5 answers codified; §5b positioning locked
- [x] Identity pillars locked: crow voice + Night Shift
- [x] **Anatomy rev.2 locked: daemon + relay + in-harness packs (MCP/slash/hooks); native TUI demoted; `/pru:*`-inside-Claude-Code as primary UX** (founder-directed, Boiler-13-aligned)
- [x] Field Day > build day: every architecture claim resolved against receipts in one afternoon.

**Day 1 outcome: ledger open, opponent mapped, voice locked, flagship story locked, product anatomy RESHAPED around the user's actual pane. 🪶⚖️**

---

## 7. ⏭️ NEXT AGENT ACTION — OWNER GATES, then F5/N-track

> **F4 code is done. Owner gates resolved 2026-09-11:**
> 1. **LICENSE: MIT** — committed. (Copyright names Ronny Sanchez Merino;
>    say the word if the holder should read differently.)
> 2. **Visibility: stay private** — public flip rides F5 launch.
> 3. **Live capture: open** — no answer yet; SYNTHETIC fixtures stand,
>    labeled, until a real anonymized capture lands.
> Landing page waits on the domain decision.
>
> Next: **F5 (launch)** then the **N-track (Graveyard)**: N1 snapshotter +
> diff builder with 50%-priced estimates (plan §3.6).

**Standing constraints: cheapest-first; replay determinism is the
checkpoint; Night Shift is the spine's showcase, not extra scope;
in-harness packs are thin glue — daemon owns all truth.**

### F4 close-out log (2026-09-11, owner: agent session)

- Built: `tests/durability.test.ts` (file-DB close/reopen/continue,
  cross-file replay equality, concurrent-burst reservation safety — no
  dangling `reserved` rows or cap counters); `docs/coverage.md` (route
  table, usage semantics, four honest gaps); synthetic-but-faithful
  `claude-code-session.json` + `claude-code-stream-sse.txt` (tool_use
  turns, cached usage → 6,900 micro actuals, replayed green);
  `README.md` (savings pitch, install, control-plane table, demo story);
  `.gitignore`; `pru demo` (in-process stub upstream: 4 posted calls on a
  $0.01 cap → canonical refusal → `loop_blocked` storm guard → replay
  verify → report; throwaway DBs, zero trace).
- Verified: `bun test` 29 pass / 0 fail across 4 files; `pru demo` runs
  the v0.1 (a)–(d) story end to end on a cold checkout with no keys.
- Deviations logged: (i) Live capture is SYNTHETIC and labeled — no keys
  exist in this environment and tests must never call live APIs; swap on
  owner capture. (ii) No OpenAI-compat fixture yet (extractors handle both
  envelopes; parity unclaimed). (iii) Loop strikes are per-daemon-run
  (documented in coverage.md; DB-derived counter is clean F5 work).
  (iv) LICENSE + public flip + landing explicitly not done — owner gates
  above.

### F3.5 close-out log (2026-09-11, owner: agent session)

- Built: `src/compress/index.ts` (JSON compaction, log collapse with
  head+tail+marker, whitespace squeeze, identical-block dedup with verbatim
  first occurrence; strip-list honored; no delta-encoding — diffs the model
  must reconstruct in its head are not provably lossless, stays out);
  relay pre-forward pass gated by `min_save_tokens` (default 200),
  savings booked in `usage_ledger.tokens_saved`; guard still prices the
  original body (pessimistic); `compression` rule seeded armed-by-default;
  CLI `compress on/off` (control-plane switch, 7th command group).
- Verified: `bun test` 26 pass / 0 fail — ladder units (JSON round-trips,
  logs collapse while prose survives, small fields untouched, dedup stubs,
  strip honored); echo-mock relay proof on a deterministic 38k-token
  fixture (1,200-line log dump + repeated JSON): forwarded bytes shrink
  past threshold, ledger `tokens_saved` matches measured savings, system
  prompt and first message byte-identical, log head verbatim + elision
  marker; $0.05 cap refuses the fixture pre-compression (would-be $0.0018
  actuals never tempt the guard); disabled rule → byte-identical
  passthrough; small traffic forwards untouched.
- Deviations logged: (i) Tallies rows deferred — savings live in
  `usage_ledger.tokens_saved` until the voice layer lands (per
  002_plan13_compat). (ii) "Transparent by default" read as governing
  spend decisions (no caps → no refusals); compression is a documented,
  counted, reversible default with two off-switches (rule row,
  `PRU_COMPRESS=off`).

### F3 close-out log (2026-09-11, owner: agent session)

- Built: `003_ledger_rules.sql` + rule helpers (`setRule`/`getRule`/
  `applicableRules`, `loopWindow`, `minuteSpendMicro`, `sessionSpentMicro`,
  loop_guard seeded armed-by-default window 3); relay refusal-retries guard
  (strikes per session, reset on posted actuals, `loop_blocked` with the
  canonical circular-spending string) + `rate_limit` pace check
  (token-bucket: empty window always admits one call); CLI `install`
  (Claude settings write), `shell` (env-injected subshell), `pace set/off`;
  `install.sh` (bun check → install → shim → install → status);
  `packs/claude-code/commands/pru-status.md`, `packs/codex/AGENTS-snippet.md`;
  `AGENTS.md` layout updated to the rev.2 tree; `tests/thrash.test.ts`;
  F1 `.gitkeep`s removed (dirs are real now).
- Verified: `bun test` 17 pass / 0 fail — retry storm (8 identical calls
  on a $0.005 cap) yields `budget_exhausted` then `loop_blocked` with
  `Pru noticed circular spending`, 1 upstream call total; posted actuals
  reset strikes; pace trips `rate_limited` with the pacing message before
  the cap binds; `pace off` restores full speed; pack files name `pru
  status`, read-only wallets, STOP. Live smoke (throwaway HOME): `install`
  writes settings.json, `pace set/off` round-trips, `shell` injects all
  three base-URL vars.
- Deviations logged: (i) Pace uses admit-iff-empty-window token-bucket
  semantics — a strict minute+cost_max check would permanently lock out
  sessions whose single-call estimate exceeds a small pace while telling
  them to "retry shortly". (ii) F2 was never committed, so the tree holds
  F2+F3 uncommitted; recommend one commit per phase at review time (shared
  files make post-hoc splitting impractical — accept a combined F2+F3
  commit). (iii) `node_modules/` untracked, no `.gitignore` yet — add one
  before F4 goes public. (iv) §3 repo URL + landing items still pending
  the F4 pass.

### F2 close-out log (2026-09-11, owner: agent session)

- Built: `package.json` + `tsconfig.json` (Bun, Hono, commander);
  `src/ledger/migrations/001_init.sql` (session, usage_ledger, cap_state,
  refusal_events — INTEGER micro-USD) + `002_plan13_compat.sql` (rename map);
  `src/ledger/db.ts` (WAL, migrate, ensureSession, txn reserve→reconcile,
  idempotent abort, setCap/clearCap, getStatus);
  `src/ledger/pricing.ts` (versioned table, envelope `estimateCall`,
  integer actuals); `src/relay/server.ts` (Hono app, session resolve,
  guard txn, LOUD typed 429, SSE passthrough tap, abort listener,
  fail-closed unknown_price + key_missing); `src/cli.ts` (`budget set`,
  `budget off`, `status`, `start`); `tests/relay.test.ts` + 2 SSE/JSON fixtures.
- Verified: `bun test` 11 pass / 0 fail — money round-trip, estimator
  honesty (unknown model → unknown_price), transparent passthrough with
  real token counts, $0.10 cap → canonical
  `Pru closed the ledger…`, overshoot ≤ cap + 4_179 micro (1 reservation),
  refused call never hit upstream, replay determinism across fresh DBs,
  chunk-order-preserving SSE with tap reconciliation (150 in / 90 out),
  mid-stream abort → row `aborted` + reservation released, unpriced model
  under cap fails closed. Live smoke: `pru budget set 5` + `status` share
  one DB with the daemon; keyless daemon POST → typed `key_missing` 429.
- Deviations logged: (i) `better-sqlite3` native binding does not load
  under Bun 1.3 (ERR_DLOPEN_FAILED) — swapped to built-in `bun:sqlite`,
  owner-approved, `AGENTS.md` updated. (ii) Syllabus F2–F5 rows above
  rewritten to the plan §2.6 phase names (old labels were rev.1 research
  tasks). (iii) File count exceeds Boiler ≤5 (13 paths); split suggested
  for F3. (iv) `AGENTS.md` repo layout still pre-rev.2 (flagged in F1);
  layout update deferred to F3. (v) Repo remote is `prudence-cli/prudence` — §3 still names the
  old personal URL; correct §3 on the F4 pass.

### F1 close-out log (2026-09-11, owner: agent session)

- Built: `docs/runcap-study.md` (runcap@0.6.0 adopt/reject/must-not-copy +
  §0 re-decision: no plan change), `docs/relay-design.md` (LOUD 429,
  JSONL→rev.2 schema map, envelope estimate signature, v0.1 a–d),
  `NOTICE` (Runcap MIT attribution), skeleton `src/relay/`,
  `src/ledger/`, `packs/claude-code/commands/`, `packs/codex/` (.gitkeeps).
  7 files / 4 logical changes (study, design, attribution, skeleton).
- Verified: `bun test` → 0 test files, 0 failures (skeleton-only, vacuous
  green); `bun --version` 1.3.13. No implementation, so plan §2.6-F1
  fixture acceptance rolls to F2 with the harness above.
- Deviations logged: (i) `pip install -e .` banner N/A — stack is Bun/TS,
  no pyproject; F2 scaffold owns the equivalent smoke (`bun install` +
  `bun test`). (ii) `AGENTS.md` repo layout still shows the pre-rev.2
  tree (`src/server|proxy|rules|...`); rev.2 skeleton (`src/relay/`,
  `src/ledger/`, `packs/`) wins — `AGENTS.md` layout update rides the F2
  PR. (iii) Plan §1.3 REAL money columns → rev.2 INTEGER micro-USD
  migration lands in F2 `001_init.sql`.

---
*"The receipt wall is the moat. The ledgers record. I include everything they sell, and the panic they advertise during the stall." — Pru* 🐦
