---
title: Apply the documentation dispositions
floor:
  - command-exit
  - recorded-artifact
job: null
autonomy: auto
needs:
  - tracker
  - docs
---
Apply every recorded disposition and no unruled change. Update task text and linked task documents through the tracker named in `facts`. Update or retire canon and knowledge-base entries through the docs adapter named in `facts`, using the adapter's actions from the composition. Never edit a hydrated canon file in `{{worktree}}`; after an authoritative canon write, use the project's documented hydration mechanism only when a refreshed mirror belongs in the change.

Rewrite records as present truth rather than appending a change log. Preserve useful rationale in the store suited to it, remove superseded claims instead of leaving contradictions, and create no document merely to satisfy the workflow. A leave disposition makes no content change and retains its recorded reason.

Record every attempted disposition with its target, adapter action, and result, including explicit no-change results. This step is done only when each disposition has a successful machine-observed write or retirement, or is recorded as leave with its ruling; any failed adapter command stops the flow.
