---
title: Refresh the planning environment
floor:
  - command-exit
job: null
autonomy: auto
needs:
  []
---
Before reading code, run `orch tree refresh .` from the root of the checkout where the reading happens: the main checkout while planning, or the run's worktree once one exists. A refusal is this step's failure to report; do not work around it, substitute project-specific commands, or refresh another checkout. If the code moves, discard conclusions based on the old revision and inspect it again.

This step is done only when the refresh command exits successfully. Record the command and exit result; a warning that leaves the worktree stale does not satisfy the step.
