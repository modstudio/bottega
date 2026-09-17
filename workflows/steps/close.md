---
title: Close the task
floor:
  - tracker-transition
job: null
autonomy: auto
needs:
  []
---
Remove the worktree and delete the local branch, then run `hub task comment {{key}} "Shipped in #<number>."` and `hub task close {{key}}`.
