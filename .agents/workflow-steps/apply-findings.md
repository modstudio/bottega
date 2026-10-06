---
title: Apply accepted findings
stage: review
floor:
  - command-exit
  - recorded-artifact
job: implement
autonomy: ask
needs:
  []
---
Run this step only when triage accepted or modified at least one finding. The implementing run's branch is the shipping branch and is not renamed. Commit any architect changes to that branch before running `orch continue <implementing-run-id> <accepted-findings>`; the continuation resumes from the branch's current tip. Re-run lenses only when the review-tier canon requires it: for tier three, when a tier-three path was touched, re-run only the touched lenses.

This step is done when the implementing continuation exits successfully and records the changes and checks it performed. When no finding was accepted or modified, record that the step was not needed and make no change.
