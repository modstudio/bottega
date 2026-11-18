---
title: Judge acceptance criteria after landing
stage: ship
floor:
  - recorded-artifact
jobs: []
autonomy: auto
needs:
  - merged-change
  - tracker
---
Read the acceptance table and judge each still-owed `[after: landed]` criterion. Also judge any still-owed criterion whose observation point has already passed. Judge no criterion whose point has not arrived.

Run each criterion's named command or probe through `bottega workflow exec` at the merge commit recorded by `merge-pr`, and cite that exec as the criterion's evidence. A check that does not pass makes its criterion not met. Append the verdict and exec evidence for every criterion judged here to the acceptance table and record the updated table with `{{tracker.actions.comment}}`. When that action is `bottega workflow attach`, save the updated table to a file, run `bottega workflow attach --cursor <cursor> --file <path>`, and use its printed `attached-text:<id>` reference. Otherwise write the updated table to `{{key}}` as a tracker comment.

When every criterion due here is met, close this step on the updated table's recorded artifact. When any criterion is not met, do not proceed to promotion or task closing. Close this workflow only by running `bottega workflow handoff fix-defect --mode single --cursor <cursor> --project {{project}} --artifact <the updated table's attached-text or task reference> --reason "post-merge acceptance criterion was not met" --arg key={{key}}` and continue the same key in the successor workflow.
