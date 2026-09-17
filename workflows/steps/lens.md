---
title: Run independent review lenses
floor:
  - recorded-artifact
job: review-lens
autonomy: auto
needs:
  []
---
Use `/absolute/path/to/main-checkout/bin/orch` from the main checkout, never a worktree's ./bin/orch, which writes to an empty per-worktree orch.db. Dispatch each named lens against the branch. Always run correctness. Also run migration-safety when the change touches `orchestrator/src/db.ts` or `orchestrator/migrations/`. Also run craft when the change adds a new module.

`/absolute/path/to/main-checkout/bin/orch do review-lens --review {{branch}} --key {{key}} --lens correctness "Review {{key}}: the change on {{branch}} against its task."`

Repeat with the same prompt and --lens migration-safety or --lens craft when those apply.
