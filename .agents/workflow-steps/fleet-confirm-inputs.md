---
title: Confirm the subscription inputs
stage: plan
floor:
  - ruling
operatorRuling: true
job: null
autonomy: ask
needs: []
---
Read section 1 of `bottega doc show agent-fleet-cost-value-review --scope global`. Bottega cannot see what a subscription costs or whether its allowance changed, so nothing downstream may be computed until the operator confirms them.

List every agent whose billing is `subscription` in `bottega agent list`. For each, look up the vendor's current pricing page and recent reports of allowance changes, citing each source and saying whether it is the vendor's own. Present to the operator: the last confirmed monthly fee, any allowance change found, and the question of whether the plan has run out recently. In full mode, also ask for the electricity price and where a server could live.

This step is done only when the operator's answers are recorded as a ruling with `--from-operator` that names each fee, each allowance, and any recent quota trouble.
