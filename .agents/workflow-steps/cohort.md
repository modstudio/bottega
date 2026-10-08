---
title: Group by root cause
stage: plan
floor:
  - recorded-artifact
job: null
autonomy: auto
needs:
  []
---
Cluster the collected signals by mechanism, never by text similarity. Put every signal in exactly one cohort. A signal whose mechanism is unknown forms its own cohort and is marked unknown.

Do not choose which cohorts will be worked; `select` does that. Escalate under the ordinary rule when a grouping turns on a true design decision, never because of how many signals were collected. This step is done when the artifact names every cohort, its mechanism or unknown status, and all of its signals.
