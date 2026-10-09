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
When the finished run's worktree is absent, open its branch in a project-provisioned tree with `orch tree open <run-id>` and rebind the `worktree` argument to the path it prints. In that worktree, fetch origin and rebase `{{branch}}` onto `origin/{{trunk}}`. If the rebase reports a conflict, stop and return it to the branch owner to resolve; do not guess at a resolution.

The project's required services are `{{mainStack.requiredServicesText}}`. When this list is not `none`, each listed service must be running in the registered main checkout before the gate; start them there with `docker compose up -d --wait` followed by the listed service names.

This step is done only when both the fetch and rebase commands exit successfully and `{{branch}}` is based on the fetched `origin/{{trunk}}`.
