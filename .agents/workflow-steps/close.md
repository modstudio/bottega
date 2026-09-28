---
title: Close the task
stage: ship
floor:
  - tracker-transition
expectedStatus: "{{tracker.states.done}}"
requirePullRequest: true
job: null
autonomy: auto
needs:
  - tracker
---
Remove the worktree and delete the local branch, then run `hub task comment {{key}} "Shipped in #<number>."` and `hub task close {{key}}`.
