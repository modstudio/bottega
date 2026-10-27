---
title: Close the task
stage: ship
floor:
  - "{{shipTo.closeFloor}}"
expectedStatus: "{{shipTo.closeState}}"
requirePullRequest: true
operatorRuling: true
job: null
autonomy: auto
needs:
  - release
  - tracker
  - ship-to
---
This run's close action is `{{shipTo.closeAction}}`.

When it is `done` or `review`, move `{{key}}` in the {{tracker.kind}} tracker through {{tracker.protocol}} to `{{shipTo.closeState}}` with `{{tracker.actions.status}}`. That is the tracker's done state when no release rung remains unreached, or when the project declares that its tracker completes a task on merge (`tracker.completesOnMerge`), so Bottega never undoes the tracker's own transition. Otherwise it is the review state while rungs remain ({{shipTo.remainingText}}): a task that stops short of production is finished by the operator. Record the pull request link on the task through the tracker named in `facts`, as a comment where the tracker has one and otherwise in the task's description, then read the task back with `{{tracker.actions.get}}`. The step is done only when the read-back shows `{{key}}` in `{{shipTo.closeState}}` and the task's pull request has merged.

When it is `ask`, either release rungs remain ({{shipTo.remainingText}}) and this tracker has no review state and does not complete tasks on merge, or this run's ship-to level leaves the pull request open. Leave `{{key}}` in its current state. Record the pull request link on the task, then ask the operator how to finish it with `bottega workflow await`, and stop. When the operator has answered, do what the answer says and close this step on that ruling. Only the operator's answer closes it on this path.
