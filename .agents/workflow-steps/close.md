---
title: Close the task
stage: ship
floor:
  - tracker-transition
expectedStatus: "{{shipTo.closeState}}"
requirePullRequest: true
job: null
autonomy: auto
needs:
  - tracker
  - ship-to
---
Remove the worktree and delete the local branch, then run `hub task comment {{key}} "Shipped in #<number>."`. When no release rung remains unreached, run `hub task close {{key}}`. While rungs remain ({{shipTo.remainingText}}), move `{{key}}` to `{{shipTo.closeState}}` with `{{tracker.actions.status}}` instead: a task that stops short of production is finished by the operator.
