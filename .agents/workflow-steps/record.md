---
title: Check the record
stage: plan
floor:
  - recorded-artifact
job: null
autonomy: auto
needs:
  - tracker
---
For each cohort, search this project's {{tracker.kind}} tracker through {{tracker.protocol}} with `{{tracker.actions.search}}` for work live on that mechanism now and for fixes that already closed it. Record a count and a pointer for each category, not an analysis.

Do not read what a past fix did or rule on what the signal's return means; `recurrence` in `plan-task` does that. This step is done when every cohort has a live-work count with pointers and a closed-fix count with pointers.
