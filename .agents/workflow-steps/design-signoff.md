---
title: Operator signs off the design
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
job: null
autonomy: ask
needs: []
---
Present the complete design, its database-change list, and its significant-name list to the operator. This step runs only when `design` closed with `schema-or-names`. It cannot be closed by an agent ruling: record the operator's answer with `bottega workflow rule --from-operator`.

Close with `approved` when the operator approves the design. Close with `revise` when the operator rejects the design or requests a rename; that outcome returns to `design` so its design and lists can be revised and presented for signoff again.
