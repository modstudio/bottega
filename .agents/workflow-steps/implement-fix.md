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
Write the fix specification to a file: the recorded diagnosis, the before-fix reproduction, the fix to make, and what must remain true. Dispatch `orch do implement --key {{key}} --file <specification file>`. Fix the diagnosed root cause across the whole affected cohort without broadening the task beyond that cause.

This step is done when the implementing run records the changed files, the fix it applied, and the checks it ran. A new design decision or a contradiction between the diagnosis and the code stops the step for a ruling rather than being resolved inside the fix.
