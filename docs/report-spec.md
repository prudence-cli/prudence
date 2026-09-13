# `pru report` spec (design only)

Date: 2026-09-13. Status: queued after K1/P1 (trust track first).
Question answered: how do users see savings and spend without a dashboard?

## 1. Position

A receipt, not a cockpit. `pru report` renders one self-contained HTML
file from the local ledger: no server, no network, no account. Open it,
print it, archive it, send it. It competes with screenshots of
dashboards by being *evidence* — every number traces to a ledger row id
shown beside it. (Standing rule: a number without a traceable source
row renders as "insufficient data.")

Explicitly not: realtime views, server mode, team rollups, hosted
sharing, push alerts. Those are the hosted/track non-goals wearing a
trenchcoat.

## 2. Invocation

```sh
pru report [--since 7d] [--session <id>] [--output report.html]
pru tallies            # terminal sibling, already ships
```

`/pru:report` slash wrapper runs it and reports the file path. Defaults:
all-time, latest session highlighted, `./pru-report-<date>.html`.

## 3. Sections (each maps to ledger queries)

1. **Header** — generated-at, DB path, row counts, truth badge
   ("rendered from N ledger rows; replay-verified" when the
   determinism check passes on export).
2. **Savings (Tallies)** — totals by kind (`night_discount`,
   `loop_blocked`, `compression_saving`, `cache_hit`), window +
   all-time; night rows show wholesale-vs-standard pairs.
3. **Spend (Meter Watch)** — sessions table: agent, project, calls,
   posted, caps with headroom bars; refusals by type with messages
   (the why, quoted exactly).
4. **Nights (Graveyard)** — jobs with status, verdict line, commit,
   PR link, est-vs-real; conflict/failed entries keep their reasons.
5. **Honesty footer** — relayed-spend-only disclaimer, coverage gaps
   (unseen routes, synthetic fixtures until swapped), pricing table
   version + verified date.

## 4. Rendering constraints

- Single `.html`, inline CSS only, zero JS, zero external assets.
  Printable, emailable, archivable for years.
- Palette: dark crow + copper (landing concept). Monochrome-safe
  glyphs; no emoji in refusal/error rows (voice law).
- Prose in the bookkeeper's voice; canonical strings reused exactly
  (`Pru set aside $X.XX…`, `Pru closed the ledger…`).

## 5. Acceptance criteria

1. Generated from a fixture DB in tests: every section present, every
   figure equals the ledger query (no hand numbers).
2. `pru report` on a live DB reproduces `digest` + `tallies` figures
   exactly (same queries, different clothes).
3. File opens from `file://` with no console errors and no network
   requests (assert by construction: no `src=`/`href=` remote).
4. `bun run check` green.

## 6. Sequencing

After K1 (keychain) + P1 (passthrough). The trust track changes what
identities and units the ledger holds; the report renders whatever the
ledger holds, so it goes last.
