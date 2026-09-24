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
Run `{{gate}}` in `{{worktree}}` in the foreground against the exact tree that will ship. Then, in `{{worktree}}`, run `orch check --enabled --project {{project}}`.

This step is done only when both commands exit zero. A skipped, backgrounded, partial, or unavailable gate or enabled project check does not complete it.
