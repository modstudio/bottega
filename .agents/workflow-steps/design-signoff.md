---
title: Operator signs off the design
stage: plan
floor:
  - ruling
operatorRuling: true
job: null
autonomy: ask
needs: []
---
Present the complete design, its database-change list, and its significant-name list to the operator. This step runs only when `design` closed with `schema-or-names`. It cannot be closed by an agent ruling: record the operator's answer with `bottega workflow rule --from-operator`.

An approval closes the step. If the operator rejects the design or requests a rename, return to `design`, revise the design and its lists, and present the result for signoff again.
