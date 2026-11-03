---
title: Rebase onto trunk
stage: ship
floor:
  - command-exit
job: null
autonomy: auto
needs:
  - trunk
  - mainStack
---
When the finished run's worktree is absent, open its branch in a project-provisioned tree with `bottega tree open <run-id>` and, on the next `bottega workflow next`, pass `--arg worktree=<the path it prints>` along with the other `--arg` values; through MCP, pass it in `next_workflow_step`'s `args` as `worktree`. In that worktree, fetch origin and rebase `{{branch}}` onto `origin/{{trunk}}`. If the rebase reports a conflict, stop and return it to the branch owner to resolve; do not guess at a resolution.

The project's required services are `{{mainStack.requiredServicesText}}`. When this list is not `none`, each listed service must be running in the registered main checkout before the gate; start them there with `docker compose up -d --wait` followed by the listed service names.

This step is done only when both the fetch and rebase commands exit successfully and `{{branch}}` is based on the fetched `origin/{{trunk}}`.
