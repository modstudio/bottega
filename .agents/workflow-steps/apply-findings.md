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
Run this step only when triage accepted or modified at least one finding. The implementing run's branch is the shipping branch and is not renamed. Commit any architect changes to that branch. Because `orch continue` refuses while the branch is checked out in an architect tree, release that tree with `orch tree remove <worktree>` before running `orch continue <implementing-run-id> <accepted-findings>`; the continuation resumes from the branch's current tip. After the continuation finishes, reopen the architect tree with `orch tree open <run-id>` and rebind the `worktree` argument to the path it prints. Re-run lenses only when the review-tier canon requires it: for tier three, when a tier-three path was touched, re-run only the touched lenses.

This step is done when the implementing continuation exits successfully and records the changes and checks it performed. When no finding was accepted or modified, record that the step was not needed and make no change.
