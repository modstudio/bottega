---
title: Implement the diagnosed fix
stage: implement
floor:
  - recorded-artifact
job: implement
autonomy: auto
needs:
  []
---
Dispatch `orch do implement --key {{key}}` with the recorded diagnosis and before-fix reproduction. Fix the diagnosed root cause across the whole affected cohort without broadening the task beyond that cause.

This step is done when the implementing run records the changed files, the fix it applied, and the checks it ran. A new design decision or a contradiction between the diagnosis and the code stops the step for a ruling rather than being resolved inside the fix.
