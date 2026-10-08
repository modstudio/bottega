---
title: Rule on recurrence
stage: plan
floor:
  - recorded-artifact
job: null
autonomy: auto
needs:
  []
---
Find every prior task, pull request, fix document, and commit that addressed this mechanism, and read what each fix did. Determine whether the present report is a new symptom or evidence that the original fix was wrong. A second patch aimed at one mechanism is the signal to step back and make this determination before designing another fix.

Do not use this step to establish whether relevant history exists; `dedupe` does that. Read the history that step found and rule on what it means. Record every prior fix read and exactly one determination: `new symptom` or `original fix wrong`. When no prior fix was found, record that fact and determine `new symptom`.

Escalate under the ordinary rule when the determination turns on a true design decision. Recurrence count alone never requires escalation.
