---
title: Merge and pull
stage: ship
floor:
  - command-exit
  - recorded-artifact
job: null
autonomy: ask
needs:
  []
---
Before merging, run `orch check --enabled --project {{project}} --pr <link>` and proceed only when it exits zero. Merge on GitHub with `gh pr merge <number> --squash --delete-branch`. Then, in the main checkout, run `git pull --ff-only`, and run `orch migrate` and `hub migrate` when the change carries a migration.
