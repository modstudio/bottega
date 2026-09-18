---
title: Run independent review lenses
floor:
  - recorded-artifact
job: review-lens
autonomy: auto
needs:
  []
---
From the main checkout's `orch`, run `orch review tier {{branch}}`. Read the stack and project documents named by the composition, then choose independent lenses for that tier. Always include correctness. Choose the remaining lenses from those documents, dispatch exactly the tier's number of independent lenses, and at tier zero still dispatch one correctness lens.

Dispatch each lens with `orch do review-lens --review {{branch}} --key {{key}} --lens <id>`. Never exceed the tier's review-round ceiling. When the ceiling is reached, stop and ask the operator instead of starting another round.

This step is done only when the review holds one recorded result for every dispatched lens, including an explicit no-findings result when a lens found nothing.
