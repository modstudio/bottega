---
title: Review blast radius
stage: review
floor:
  - recorded-artifact
job: review-lens
autonomy: auto
needs: []
---
Use `/absolute/path/to/main-checkout/bin/bottega` from the main checkout, never a worktree's `./bin/bottega`, whose access to the shared per-user store is read-only. First run `/absolute/path/to/main-checkout/bin/bottega review tier <fix-branch>`, where `<fix-branch>` is the branch `bottega run result` prints for the implement run. At tier zero dispatch none. Read the whole diff, record on the task that tier zero runs no lens and what you read, and close this step on that comment. At any higher tier, dispatch the lens as follows. Run `/absolute/path/to/main-checkout/bin/bottega run start review-lens --review <fix-branch> --key {{key}} --lens issue-blast-radius "Review the fix for {{key}} for its blast radius."`, where `<fix-branch>` is the branch `bottega run result` prints for the implement run.
