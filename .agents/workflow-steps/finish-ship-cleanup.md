---
title: Finish ship cleanup
stage: ship
floor:
  - command-exit
job: null
autonomy: auto
needs: []
---
Run from the registered main checkout. Remove the architect landing tree with `bottega tree remove {{worktree}}`, then run `bottega tree ship-cleanup {{branch}}`. The cleanup command exits nonzero and prints every held item and its reason when any task tree, run-minted landed branch, recipe database, Compose resource, process, or artifact remains. Leave this step open on any nonzero exit and report every printed hold. This step is done only when both commands exit zero and cleanup prints `kept: none`.
