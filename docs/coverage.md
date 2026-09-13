# Relay coverage (F4)

What the relay intercepts, what it does not, and what remains to be proven
against live traffic. Honest incapacity beats horoscopes: anything below
marked otherwise is verified by fixture replay in `tests/`.

## Intercepted

| Route | Mechanism | Verified by |
|---|---|---|
| `POST /v1/messages` (Anthropic, JSON) | `ANTHROPIC_BASE_URL=http://localhost:8787` | `tests/relay.test.ts` + `claude-code-session.json` |
| `POST /v1/messages` (Anthropic, `stream:true`) | SSE passthrough, parallel tap | `anthropic-sse.txt`, `claude-code-stream-sse.txt` |
| `POST /v1/chat/completions` (OpenAI-compat, JSON + SSE) | `OPENAI_BASE_URL=http://localhost:8787/v1` | `openai-chat-request.json` + usage incl. cached tokens (parity proven 2026-09-13) |
| Doubled `/v1` prefix | stripped when upstream base ends in `/v1` | `upstreamUrlFor` unit path (covered indirectly) |

## Header forwarding (live-fire hotfix, 2026-09-11)

Feature headers pass through verbatim: `anthropic-beta`,
`anthropic-version` (client wins), `user-agent`, `accept` — and the
OpenAI equivalents (`openai-beta`, `openai-organization`,
`openai-project`). Stripping them broke real traffic: Haiku calls
carrying context-management params died upstream with 400s while plain
calls passed. Auth never passes through — Pru injects its own key
(BYOK boundary).

## Usage accounting
- Anthropic: `input_tokens` / `output_tokens` / `cache_read_input_tokens`
  (cached billed at the reduced rate; `input_tokens` includes cached, so
  fresh = total − cached, floored at zero).
- OpenAI: `prompt_tokens` / `completion_tokens` /
  `prompt_tokens_details.cached_tokens`.
- Streaming: per-field max across SSE `data:` frames (providers send
  cumulative counters). Frames without usage are skipped; a stream with no
  usable usage reconciles as `degraded_parse` — the stream itself is never
  held back.
- Unknown model: no price invented (`unknown_price`); capped sessions fail
  closed, uncapped sessions pass through marked.

## Known gaps (do not claim otherwise)

1. **Internal agent routes that ignore `ANTHROPIC_BASE_URL`.** Some harness
   internals reportedly bypass the env var. Mitigation: per-agent recorded
   fixtures in CI plus this doc. A route we never see is spend we never
   book — `pru status` reports relayed spend only.
2. **No live OpenAI-compat capture yet.** A committed fixture replays
   the envelope (parity proven), but it is synthetic like the Claude
   ones. Record one Codex session before claiming more.
3. **Live capture still synthetic.** `claude-code-session.json` and
   `claude-code-stream-sse.txt` are labeled SYNTHETIC: protocol-faithful
   shapes, not anonymized live traffic. Standing task: record one live
   Claude Code session (owner keys required — tests must never call live
   APIs), anonymize, and swap the fixtures.
4. **Loop strikes are per-daemon-run.** The consecutive-refusal counter
   lives in relay memory; a daemon restart resets it. Refusal rows persist,
   so a DB-derived counter is a clean F5 upgrade.
