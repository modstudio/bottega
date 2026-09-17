---
title: Refresh the planning environment
floor:
  - command-exit
job: null
autonomy: auto
needs:
  []
---
Before reading code, run this project's registered worktree refresh recipe in the run's worktree. Use the recipe as declared; do not substitute project-specific commands or refresh another checkout. If the code moves, discard conclusions based on the old revision and inspect it again.

This step is done only when the refresh command exits successfully. Record the command and exit result; a warning that leaves the worktree stale does not satisfy the step.
