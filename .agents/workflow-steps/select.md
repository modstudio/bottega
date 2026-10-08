---
title: Select work
stage: plan
floor:
  - ruling
operatorRuling: true
job: null
autonomy: ask
needs:
  []
---
Present every cohort with its signal count, live-work count, and closed-fix count. The operator chooses whether each cohort is worked and, for every selected cohort, whether it is one related group planned together or a set of unrelated fixes planned separately.

Do not regroup the signals or plan the work. This step is done only when every cohort is recorded as selected or not selected by an operator ruling. Hand each selected cohort to `plan-task`, in `fix` mode for incorrect behavior and `feature` mode otherwise, carrying the cohort's signals and record pointers; hand unrelated fixes over separately.
