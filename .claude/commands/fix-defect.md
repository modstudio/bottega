---
name: fix-defect
description: Fix one reported defect
argument-hint: "<key>"
generated-by: orch workflow hydrate
---
A projection of the 'orch fix-defect' command's coordinator for inspection.

| Mode | Title | Default |
| --- | --- | --- |
| `default` | Resolve | yes |

Call the orch MCP tool `compose_workflow` with `workflow: "fix-defect"`, the chosen mode, and the arguments taken from `$ARGUMENTS` in declared order (equivalently `orch workflow compose fix-defect --mode <mode> --arg key=<value>`), then follow the composed prompt exactly and do not reproduce the workflow from memory.
