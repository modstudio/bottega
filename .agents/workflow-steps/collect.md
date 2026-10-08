---
title: Gather signal
stage: plan
floor:
  - recorded-artifact
job: null
autonomy: auto
needs:
  - signals
---
Collect the open signals and their diagnostics from every source declared in `facts.signals.sources`, limited to the optional `scope` argument when the caller supplied it. Preserve raw signal only: do not group, rank, or interpret it. When the declared source list is empty, collect the signals the caller supplies and state in the artifact that they came from the caller.

Do not group signals; `cohort` does that. Do not ask the tracker what it already knows; `record` does that. This step is done when an artifact lists every signal with its source and identifier, and names every source that could not be read as unread rather than reporting it as empty.
