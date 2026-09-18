---
title: Rule on every documentation deviation
floor:
  - human-ruling
job: null
autonomy: ask
needs: []
---
Compare the gathered implementation with the task text, linked documents, canon, decision records, and knowledge-base entries. List every place where the written record is missing, stale, contradicted, superseded, or describes work that was not built. Include documents outside the optional scope when the gathered evidence shows that the scoped change made them inaccurate.

Present one complete deviation table. For every deviation, require a human to choose exactly one disposition:

- **Update** — rewrite the record to describe current reality.
- **Retire** — remove or retire a record that is no longer true or useful.
- **Leave** — keep it unchanged, with the human's explicit reason recorded.

Do not silently treat an implementation difference as documentation truth. If the implementation appears wrong rather than the record, identify it as such so the human can leave the documentation unchanged and return the defect to implementation. When no deviations exist, record that result explicitly and continue without a ceremonial ruling.

This step blocks until every listed deviation has one recorded disposition and every leave disposition has a reason. Group approval is valid only when it unambiguously covers every row.
