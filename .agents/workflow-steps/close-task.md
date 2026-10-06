---
title: Close the task
stage: ship
floor:
  - "{{shipTo.closeFloor}}"
expectedStatus: "{{shipTo.closeState}}"
operatorRuling: true
job: null
autonomy: auto
needs:
  - release
  - tracker
  - ship-to
---
This run's close action is `{{shipTo.closeAction}}`.

When it is `done` or `review`, move `{{key}}` in the {{tracker.kind}} tracker through {{tracker.protocol}} to `{{shipTo.closeState}}` with `{{tracker.actions.status}}`. That is the tracker's done state when no release rung remains unreached, and its review state while rungs remain ({{shipTo.remainingText}}): a task that stops short of production is finished by the operator. Record the pull request link on the task through the tracker named in `facts`, as a comment where the tracker has one and otherwise in the task's description, then read the task back with `{{tracker.actions.get}}`. The step is done only when the read-back shows `{{key}}` in `{{shipTo.closeState}}` and the task record contains the pull request link.

When it is `ask`, release rungs remain ({{shipTo.remainingText}}) and this tracker has no review state. Leave `{{key}}` in its current state. Record the pull request link on the task, then ask the operator how to finish it with `orch workflow await`, and stop. When the operator has answered, do what the answer says and close this step on that ruling. Only the operator's answer closes it on this path.
