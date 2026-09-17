---
title: Rebase and verify
floor:
  - command-exit
job: null
autonomy: auto
needs:
  - gate
---
In `{{worktree}}`, run `git fetch origin` and `git rebase origin/main`, run `bun install` in the repository root, `orchestrator/` and `hub/`, then run `{{gate}}` in the foreground. If the gate fails only because a ceiling baseline tightened, commit the rewritten `scripts/quality/*.json` and re-run.
