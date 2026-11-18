---
title: Finish ship cleanup
stage: ship
floor:
  - command-exit
jobs: []
autonomy: auto
needs: []
---
Run from the registered main checkout, and first bring it up to its landing branch with `bottega tree refresh .`. Then run `bottega tree ship-cleanup {{branch}}`. It finds the landing tree and every other run-made tree, branch and resource of the shipped branch by the branch alone, and releases each one nothing still holds, so the landing tree needs no separate removal. A tree that something other than Bottega made has no run record, so cleanup neither releases nor reports it: when the landing tree you merged from is one, first remove it with the tool that made it, so whatever that tool provisioned is released, and never with a bare `git worktree remove` for a project-made tree. The cleanup command exits nonzero and prints every held item and its reason when any task tree, run-minted landed branch, recipe database, Compose resource, process, or artifact remains. Leave this step open on any nonzero exit and report every printed hold. This step is done only when both commands exit zero and cleanup prints `kept: none`.
