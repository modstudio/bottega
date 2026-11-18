---
title: Judge acceptance criteria after pull request CI
stage: ship
floor:
  - recorded-artifact
jobs: []
autonomy: auto
needs:
  - gate
  - tracker
---
Read the acceptance table and judge each still-owed `[after: pr-ci]` criterion. Also judge any still-owed criterion whose observation point has already passed. Judge no criterion whose point has not arrived.

Use the pull request link or a successful `bottega gate check --enabled --project {{project}} --pr <link>` execution as the point's evidence. Run each criterion's named command or probe through `bottega workflow exec --cwd {{worktree}} -- <check>`. A check that does not pass makes its criterion not met. Do not merge while any criterion judged here is not met; return the change to the implementer.

Append the verdict and exec evidence for every criterion judged here to the acceptance table and record the updated table with `{{tracker.actions.comment}}`. When that action is `bottega workflow attach`, save the updated table to a file, run `bottega workflow attach --cursor <cursor> --file <path>`, and close this step with the printed `attached-text:<id>` reference. Otherwise write the updated table to `{{key}}` as a tracker comment and close with `--artifact task:{{key}}`. This step is done only when every criterion due here is met and its evidence is recorded.
