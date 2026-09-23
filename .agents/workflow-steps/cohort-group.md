---
title: Group the production-signal cohort
stage: plan
floor:
  - recorded-artifact
job: null
autonomy: auto
needs:
  []
---
Read the required `signal` argument from the composition and query that exact production signal. If cohort mode was composed without a non-empty signal, stop and report the missing required mode argument.

Group the signal's occurrences by root cause rather than by operational signature, error text, or reported site. For each candidate group, record its occurrences, the evidence that joins them, and the root cause that distinguishes it from the other groups. Select the one cohort that `{{key}}` will fix and record its complete membership; do not silently include an occurrence whose root cause has not been established.

This step is done when the recorded artifact shows the queried signal, every candidate root-cause group, and the selected cohort and its membership.
