---
title: Rebase and verify
stage: ship
floor:
  - command-exit
job: null
autonomy: auto
needs:
  - gate
  - trunk
---
In `{{worktree}}`, run `git fetch origin` and `git rebase origin/{{trunk}}`, run `bun install` in the repository root, then run `{{gate}}` in the foreground. If the gate fails only because a ceiling baseline tightened, commit the rewritten `scripts/quality/*.json` and re-run.
