---
title: Judge acceptance criteria after release
stage: ship
floor:
  - recorded-artifact
jobs: []
autonomy: auto
needs:
  - release
  - tracker
---
Read the acceptance table and the `promote-release` execution. Judge each still-owed `[after: rung <name>]` criterion whose named rung that execution proved live. Also judge any still-owed criterion whose observation point has already passed. Judge no criterion whose point has not arrived. When an owed criterion's observation point has passed and no later judging step remains, mark it not met rather than leaving it owed.

For each criterion judged here, cite the `promote-release` execution for its named rung and run its named command or probe through `bottega workflow exec` from the registered main checkout. A check that does not pass makes its criterion not met. Append the verdict and both pieces of evidence for every criterion judged here to the acceptance table and record the updated table with `{{tracker.actions.comment}}`. When that action is `bottega workflow attach`, save the updated table to a file, run `bottega workflow attach --cursor <cursor> --file <path>`, and use its printed `attached-text:<id>` reference. Otherwise write the updated table to `{{key}}` as a tracker comment.

When every criterion due here is met, close this step on the updated table's recorded artifact. When any criterion is not met, do not proceed to task closing. Close this workflow only by running `bottega workflow handoff fix-defect --mode single --cursor <cursor> --project {{project}} --artifact <the updated table's attached-text or task reference> --reason "post-release acceptance criterion was not met" --arg key={{key}}` and continue the same key in the successor workflow.
