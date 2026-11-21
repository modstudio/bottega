---
title: Rule on every documentation deviation
stage: docs
floor:
  - ruling
outcomes:
  - deviations
  - no-deviations
outcomeFloors:
  no-deviations:
    - recorded-artifact
jobs: []
autonomy: ask
needs:
  - tracker
  - docs
---
Compare what was built with the task text, linked documents, canon, decision records, and knowledge-base entries. What was built is the record `docs-gather` made when sync runs on its own, or the diff `scope` recorded when sync runs inside `ship-task`. Read the documents through the tracker and docs adapters named in `facts`. List every place where the written record is missing, stale, contradicted, superseded, or describes work that was not built. Include documents outside the optional scope when that evidence shows that the scoped change made them inaccurate.

Present one complete deviation table. For every deviation, require exactly one recorded disposition:

- **Update** — rewrite the record to describe current reality.
- **Retire** — remove or retire a record that is no longer true or useful.
- **Leave** — keep it unchanged, with an explicit reason recorded.

Do not silently treat an implementation difference as documentation truth. If the implementation appears wrong rather than the record, identify it as such so the ruling can leave the documentation unchanged and return the defect to implementation. With deviations, close with `--outcome deviations` and the ruling that records every disposition. With none, close with `--outcome no-deviations` and a recorded artifact stating that no deviation was found, such as a task comment written in this step.

This step blocks until every listed deviation has one recorded disposition and every leave disposition has a reason. Group approval is valid only when it unambiguously covers every row.
