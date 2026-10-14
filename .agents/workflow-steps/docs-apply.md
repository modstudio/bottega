---
title: Apply the documentation dispositions
stage: docs
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

The docs adapter is named by `{{docs.protocol}}`. When its descriptor names a server, call its read and write actions on the server named in `facts`; otherwise, use the descriptor's listed read and write actions directly. Run every adapter command as `bottega workflow exec --cwd {{worktree}} -- <command>` so its evidence is bound to the branch; an execution recorded at a commit that is not on the branch is refused as evidence. The `orch-docs` adapter writes through `bottega doc set` with `--scope project --subject {{project}}` so the lint applies. Pass `--cwd {{worktree}}` so citations of files the change adds resolve. A design record that a disposition creates is named `design-<feature>`, unless the store has its own naming convention for feature records, and states current behavior, the reasons for its design, build or buy, anything provisional with its exit criterion, and how it is measured.

A canon store write runs ahead of trunk until its branch merges, so the gate of any other branch that changes the same canon file reports canon drift in the meantime. After a canon write, go straight on to the gate and the merge; sessions changing the same canon file take their writes one at a time.

Rewrite records as present truth rather than appending a change log. Preserve useful rationale in the store suited to it, remove superseded claims instead of leaving contradictions, and create no document merely to satisfy the workflow. A leave disposition makes no content change and retains its recorded reason.

Record every attempted disposition with its target, adapter action, and result, including explicit no-change results. This step is done only when each disposition has a successful machine-observed write or retirement, or is recorded as leave with its ruling; any failed adapter command stops the flow.
