---
title: Apply accepted findings
floor:
  - command-exit
  - recorded-artifact
job: implement
autonomy: ask
needs:
  []
---
Run this step only when triage accepted or modified at least one finding. Continue the implementing run with the accepted findings by running `orch continue <implementing-run-id> <accepted-findings>`. Re-run lenses only when the review-tier canon requires it: for tier three, when a tier-three path was touched, re-run only the touched lenses.

This step is done when the implementing continuation exits successfully and records the changes and checks it performed. When no finding was accepted or modified, record that the step was not needed and make no change.
