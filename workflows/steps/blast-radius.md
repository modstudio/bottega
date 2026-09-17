---
title: Review blast radius
floor:
  - recorded-artifact
job: review-lens
autonomy: auto
needs:
  []
---
Use `/absolute/path/to/main-checkout/bin/orch` from the main checkout, never a worktree's ./bin/orch, which writes to an empty per-worktree orch.db. Run `/absolute/path/to/main-checkout/bin/orch do review-lens --review <fix-branch> --key {{key}} --lens issue-blast-radius "Review the fix for {{key}} for its blast radius."`, where `<fix-branch>` is the branch `orch result` prints for the issue-worker run.
