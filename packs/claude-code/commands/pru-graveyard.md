---
description: Queue half-price night work
---

# /pru:graveyard

Queue arguments for the night window. Bare invocation lists the queue.

!`pru graveyard $ARGUMENTS`

Rules:

- Everything after the command name is the task, quoted as one unit.
- After queueing, report the job id, the batch-vs-standard estimate, and
  the savings exactly as printed. Never paraphrase amounts.
- Queueing writes the ledger, so it asks approval once — that prompt is
  the human authorizing future spend, not a nuisance.
- Never invent flags. `--run`, `--digest`, `--publish`, and `--schedule`
  are separate operations the human asks for by name.
