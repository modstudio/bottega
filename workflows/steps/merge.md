---
title: Merge and pull
floor:
  - command-exit
  - recorded-artifact
job: null
autonomy: ask
needs:
  []
---
Merge on GitHub with `gh pr merge <number> --squash --delete-branch`. Then, in the main checkout, run `git pull --ff-only`, and run `orch migrate` and `hub migrate` when the change carries a migration.
