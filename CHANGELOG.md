# Changelog

## v0.1.0 — Meter Watch (2026-09-11)

Pru cuts your agent bill. Local gateway daemon (`localhost:8787`) that
Claude Code and Codex settle through: hard budget caps, per-minute pacing,
circular-spending guard, noise trimmed before billing, and one SQLite
ledger behind it all.

- Relay: Hono app, session resolve, reservation → reconciliation in single
  transactions, LOUD typed 429s, SSE passthrough with parallel tap.
- Ledger: `bun:sqlite` + WAL, numbered migrations, integer micro-USD.
- Guards: armed-by-default caps, refusal-retries loop signal, token-bucket pacing.
- Compression: strip-list pass (JSON, logs, whitespace, identical dedup),
  `min_save_tokens` gate, per-call savings booked.
- Control plane: `install`, `budget`, `pace`, `compress`, `status`,
  `shell`, `start`, `demo`. In-harness: `/pru:status` pack + Codex snippet.
- 29 fixture-replay tests, mock upstreams only. `bun run check` green.

## Next — Graveyard Shift (N-track)

Non-urgent work at half price through batch execution. N1: snapshotter +
diff builder with 50%-priced estimates.
