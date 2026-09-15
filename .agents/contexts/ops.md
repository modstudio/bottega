---
description: Rules for unattended machine upkeep and scheduled operations
paths: ["ops/**"]
---

# Machine upkeep

Unattended jobs fail loudly in their logs and never make a destructive guess, because no
operator is present to correct one.

Project refresh touches main checkouts only and never worktrees. It selects the deepest
mode advertised by each project's `scripts/sync/main`, and one project failing does not
abort the remaining projects.

Every launchd template must render to a plist accepted by `plutil`. A host without
`plutil` reports that validation as unavailable rather than treating it as a gate.

Operational monitors keep their queryable record in the owning store; launchd output is
only a process log. Canon evaluation produces probe runs and never routing evidence.
