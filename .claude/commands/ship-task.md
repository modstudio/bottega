---
name: ship-task
description: Ship a task
argument-hint: "<key> <branch> <worktree> [depth]"
generated-by: orch workflow hydrate
---
Review, gate, merge, promote through the project's release rungs, and close the task at the last rung reached. The `merge` mode stops after merge and leaves promotion and closing to the caller.

| Mode | Title | Default |
| --- | --- | --- |
| `full` | Ship and promote | yes |
| `merge` | Ship through merge | no |

Call the orch MCP tool `compose_workflow` with `workflow: "ship-task"`, the chosen mode, and the arguments taken from `$ARGUMENTS` in declared order (equivalently `orch workflow compose ship-task --mode <mode> --arg key=<value> --arg branch=<value> --arg worktree=<value> --arg depth=<value>`), then follow the composed prompt exactly and do not reproduce the workflow from memory.
