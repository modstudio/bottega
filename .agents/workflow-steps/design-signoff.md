---
title: The user signs off the design
stage: plan
floor:
  - ruling
outcomes:
  - approved
  - revise
reenter:
  to: design
  outcome: revise
operatorRuling: true
jobs: []
autonomy: ask
needs: []
---
Present the complete design, its database-change list, and its significant-name list to the user. This step runs only when `design` closed with `schema-or-names`. It cannot be closed by an agent ruling: record the user's answer with `bottega workflow rule --from-operator`.

Close with `approved` when the user approves the design. Close with `revise` when the user rejects the design or requests a rename; that outcome returns to `design` so its design and lists can be revised and presented for signoff again.
