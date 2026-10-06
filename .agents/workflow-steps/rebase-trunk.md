---
title: Rebase onto trunk
stage: ship
floor:
  - command-exit
job: null
autonomy: auto
needs:
  - trunk
---
When the finished run's worktree is absent, open its branch in a project-provisioned tree with `orch tree open <run-id>`. In `{{worktree}}`, fetch origin and rebase `{{branch}}` onto `origin/{{trunk}}`. If the rebase reports a conflict, stop and return it to the branch owner to resolve; do not guess at a resolution.

This step is done only when both the fetch and rebase commands exit successfully and `{{branch}}` is based on the fetched `origin/{{trunk}}`.
