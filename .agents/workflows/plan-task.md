---
name: plan-task
description: Plan a task
argument-hint: "[key]"
generated-by: orch workflow hydrate
---
Turn an intention into an approved, evidence-based task that another worker can pick up cold. Choose the mode by kind of work; whether the task already exists is carried separately by the optional key argument. Intake records settled requirements and stops before technical design.

| Mode | Title | Default |
| --- | --- | --- |
| `feature` | Plan a feature | no |
| `fix` | Plan a fix | no |
| `chore` | Plan a chore | no |
| `intake` | Capture an intake | no |

Call the orch MCP tool `compose_workflow` with `workflow: "plan-task"`, the chosen mode, and the arguments taken from `$ARGUMENTS` in declared order (equivalently `orch workflow compose plan-task --mode <mode> --arg key=<value>`), then follow the composed prompt exactly and do not reproduce the workflow from memory.
