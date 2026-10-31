---
title: Finish ship cleanup
stage: ship
floor:
  - command-exit
job: null
autonomy: auto
needs: []
---
Run from the registered main checkout, and first bring it up to its landing branch with `bottega tree refresh .`. Remove the architect landing tree with `bottega tree remove {{worktree}}`, then run `bottega tree ship-cleanup {{branch}}`. If `bottega tree remove` refuses because no orchestrator run records the tree, something other than Bottega made it: remove it with the tool that made it, as the refusal says, so whatever that tool provisioned is released, and never with a bare `git worktree remove` for a project-made tree; then run the cleanup command. The cleanup command exits nonzero and prints every held item and its reason when any task tree, run-minted landed branch, recipe database, Compose resource, process, or artifact remains. Leave this step open on any nonzero exit and report every printed hold. This step is done only when all three commands exit zero and cleanup prints `kept: none`.
