---
description: Read Pru's ledger for this session
---

# /pru:status

Pru's daemon owns the truth. The wallet below is read-only.

!`pru status`

Report back:

- Posted spend and calls on the books for this session.
- Every armed cap and how much headroom remains.
- Every refusal row by id, quoted exactly — never paraphrase amounts.

A refusal means STOP: report the row, tell the human what it blocks, and ask
before retrying. Hammering a closed ledger trips the circular-spending guard.
