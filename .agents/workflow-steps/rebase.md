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
  - mainStack
---
In `{{worktree}}`, run `git fetch origin` and `git rebase origin/{{trunk}}`, run `bun install` in the repository root, then run `{{gate}}` in the foreground. If the gate fails only because a ceiling baseline tightened, commit the rewritten `scripts/quality/*.json` and re-run.

When the project declares required services (`{{mainStack.requiredServicesText}}` is not `none`), check they are running in the registered main checkout and start them there with `docker compose up -d --wait {{mainStack.requiredServicesText}}` before running the gate.
