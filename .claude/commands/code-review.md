---
name: code-review
description: Review code
argument-hint: "<key> <branch> <worktree>"
generated-by: orch workflow hydrate
---
Review a branch with independent lenses sized by its review tier, refute every finding before accepting it, and either report the triaged review without changing anything or apply the accepted findings and gate the result.

| Mode | Title | Default |
| --- | --- | --- |
| `report` | Report findings | yes |
| `apply` | Apply accepted findings | no |

Call the orch MCP tool `compose_workflow` with `workflow: "code-review"`, the chosen mode, and the arguments taken from `$ARGUMENTS` in declared order (equivalently `orch workflow compose code-review --mode <mode> --arg key=<value> --arg branch=<value> --arg worktree=<value>`), then follow the composed prompt exactly and do not reproduce the workflow from memory.
