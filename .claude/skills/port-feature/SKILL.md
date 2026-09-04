---
name: port-feature
description: Port task-management / workflow / MCP subsystem features between Starship, Stopal, Alephbeis, and Adanim. Scans the source project for changes since the last port, filters through documented per-project differences, and creates adapted tasks in the target project via its MCP server.
---

The ledger, pairs, baselines, skips and doctrine live in `orch.db` and are
reached through `orch port`. Project docs are reached through `orch doc show`
(`port-differences`, `port-backports` per project; `port-category-map`,
`port-doctrine-preface`, `port-stack-mapping`, `port-process-differences`,
`port-differences-unassigned`, `port-import-exclusions` global). This shim
exists only so Claude Code lists the skill; all substance is in the database.
