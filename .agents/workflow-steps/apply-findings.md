---
title: Apply accepted findings
stage: review
floor:
  - command-exit
  - recorded-artifact
job: implement
autonomy: ask
needs: []
---
Run this step only when triage accepted or modified at least one finding. The implementing run's branch is the shipping branch and is not renamed. Commit any architect changes to that branch. Because `bottega run continue` refuses while the branch is checked out in an architect tree, release that tree with `bottega tree remove <worktree>` before running `bottega run continue --findings <implementing-run-id> <message>`; `--findings` renders the round's accepted and modified findings ahead of the message, so the message carries only the rulings on how to apply them. The continuation resumes from the branch's current tip. The exit of `bottega run continue` proves only that the continuation was dispatched. Close this step on the continuation's run once that run finishes successfully, and dispatch a failed continuation again. After the continuation finishes, reopen the architect tree with `bottega tree open <run-id>`. On the next `bottega workflow next`, pass the path it prints as the `worktree` argument together with the other arguments. Re-run lenses only when the review-tier canon requires it: for tier three, when a tier-three path was touched, re-run only the touched lenses.

This step is done when the implementing continuation exits successfully and records the changes and checks it performed. When no finding was accepted or modified, record that the step was not needed and make no change.
