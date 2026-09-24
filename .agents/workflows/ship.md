---
title: Ship a task
arguments:
  - name: key
    required: true
    description: The task key.
  - name: branch
    required: true
    description: The branch to ship.
  - name: worktree
    required: true
    description: "The branch's worktree path."
modes:
  - slug: default
    title: Ship
    default: true
    steps:
      - rebase
      - lens
      - score
      - ship-triage
      - complete
      - ship-fix
      - pr
      - merge
      - design-records
      - close
---
Rebase, independently review, triage, fix, merge by pull request, and close a task.
