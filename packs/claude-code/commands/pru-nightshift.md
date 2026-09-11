---
description: Morning receipt queue for night work
---

# /pru:nightshift

Pru's daemon owns the truth. The queue below is read-only.

!`pru graveyard --digest`

Report back:

- What Pru set aside, to the cent.
- Every finished job: done (verified) or stopped, with the reason quoted.
- Any failures or conflicts: STOP, report the job id, and ask the human
  before republishing. Never re-run a failed night job silently.

Thin glue: the daemon and its ledger decide; this pane only reads.
