---
name: ship
description: Ship a task
argument-hint: "<key> <branch> <worktree>"
generated-by: orch workflow hydrate
---
Rebase, independently review, triage, fix, merge by pull request, and close a task.

| Mode | Title | Default |
| --- | --- | --- |
| `default` | Ship | yes |

Call the orch MCP tool `compose_workflow` with `workflow: "ship"`, the chosen mode, and the arguments taken from `$ARGUMENTS` in declared order (equivalently `orch workflow compose ship --mode <mode> --arg key=<value> --arg branch=<value> --arg worktree=<value>`), then follow the composed prompt exactly and do not reproduce the workflow from memory.
