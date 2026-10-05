---
title: Close the task
stage: ship
floor:
  - tracker-transition
expectedStatus: "{{shipTo.closeState}}"
job: null
autonomy: auto
needs:
  - release
  - tracker
  - ship-to
---
Move `{{key}}` in the {{tracker.kind}} tracker through {{tracker.protocol}} to `{{shipTo.closeState}}` with `{{tracker.actions.status}}`. That is the tracker's done state when no release rung remains unreached, and its review state while rungs remain ({{shipTo.remainingText}}): a task that stops short of production is finished by the operator. Record the pull request link on the task through the tracker named in `facts`, as a comment where the tracker has one and otherwise in the task's description, then read the task back with `{{tracker.actions.get}}`.

This step is done only when the read-back shows `{{key}}` in `{{shipTo.closeState}}` and the task record contains the pull request link.
