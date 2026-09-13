# Launch plan (locked 2026-09-13, gated on dogfood)

Nothing here executes before the unattended overnight lands and N4
merges. Order is deliberate: trust artifacts first, distribution
second, money last.

## Phase L1 — trust artifacts (build now, any time)

- [ ] CI workflow (`.github/workflows/check.yml`): `bun install` +
      `bun run check` on push/PR. A public repo without green checks
      reads abandoned.
- [ ] `SECURITY.md`: key handling (keychain-first, resolution order,
      never logged/persisted/transmitted except to the configured
      upstream, BYOK). For a traffic proxy this converts better than
      any feature.
- [ ] `.github/FUNDING.yml`: GitHub Sponsors link (tip jar, ~zero fees).

## Phase L2 — distribution (needs dogfood receipts)

- [ ] Domain decision: `prudence.sh` vs alternatives; register.
- [ ] Landing: dark crow + copper, one terminal GIF (`pru demo`
      recorded via `vhs`), install command, receipts wall (F0 fatals,
      tuna transcript, night digest with figures).
- [ ] Real npm release: `bun build --compile` per OS/arch in CI,
      GitHub Releases artifacts; npm wrappers or curl installer.
      Placeholders stay 0.0.1 until this ships.
- [ ] GitHub Releases v0.1.0/v0.2.0 with CHANGELOG text.

## Phase L3 — money (only on demand signals)

- Tip jar (L1) is the whole strategy until users ask for more.
- No paywalls in MIT code (source-readable checks are fork-removable
  theater). Pro/Team exist only as hosted offerings later.
- Launch post leads with savings receipts, never features.

## Explicitly not launch blockers

Live dogfood proof (in progress), N4 merges, synthetic-fixture swap.
Everything else ships as-is.
