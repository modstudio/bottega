---
title: Check the record
stage: plan
floor:
  - recorded-artifact
jobs: []
autonomy: auto
needs:
  - tracker
---
For each subject under consideration — a cohort, task, note, or question — identify the concern it represents. Search this project's {{tracker.kind}} tracker through {{tracker.protocol}} with `{{tracker.actions.search}}` for work live on that concern now and for fixes that already closed it. Record a count and a pointer for each category, not an analysis.

Do not read what a past fix did or rule on what the subject's return means; `recurrence` in `plan-task` does that. This step is done when every subject has a live-work count with pointers and a closed-fix count with pointers.
