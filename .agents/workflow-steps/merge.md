---
title: Merge and pull
stage: ship
floor:
  - command-exit
  - recorded-artifact
job: null
autonomy: ask
needs:
  - ship-to
---
The operator's ship-to level for this run is `{{shipTo.level}}`. When it is `branch`, the level stops at the pushed branch: do not merge. Record that the pull request is open and waiting for the operator with `orch workflow await`, and stop.

Before merging, run `orch check --enabled --project {{project}} --pr <link>` and proceed only when it exits zero. Merge on GitHub with `gh pr merge <number> --squash --delete-branch`. Then, in the main checkout, run `git pull --ff-only`, and run `orch migrate` and `hub migrate` when the change carries a migration.
