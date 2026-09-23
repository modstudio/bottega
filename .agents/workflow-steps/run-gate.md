---
title: Run the project gate
stage: ship
floor:
  - command-exit
job: null
autonomy: auto
needs:
  - gate
---
Run `{{gate}}` in `{{worktree}}` in the foreground against the exact tree that will ship.

This step is done only when the gate command exits zero. A skipped, backgrounded, partial, or unavailable gate does not complete it.
