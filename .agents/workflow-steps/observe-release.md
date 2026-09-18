---
title: Observe the released cohort
floor:
  - recorded-artifact
job: null
autonomy: auto
needs:
  - release
---
After promotion, read the required `signal` argument from the composition and observe that same production signal for the optional `window` argument when it is present; otherwise use the post-release observation window in `facts.release`. Do not substitute an arbitrary wait when neither supplies a window: stop and report the missing release fact.

Watch for every member of the selected root-cause cohort. Record the release and observation interval, the query or observations made, and either each recurrence with its occurrence evidence or explicit silence for the entire window. A low event rate or unavailable signal is inconclusive, not silence.

This step is done only when a recorded artifact establishes recurrence or no recurrence across the resolved observation window.
