---
title: Close the task
stage: ship
floor:
  - tracker-transition
  - ruling
expectedStatus: "{{shipTo.closeState}}"
requirePullRequest: true
operatorRuling: true
job: null
autonomy: auto
needs:
  - tracker
  - ship-to
---
Remove the worktree and delete the local branch, then run `hub task comment {{key}} "Shipped in #<number>."`. This run's close action is `{{shipTo.closeAction}}`.

When it is `done`, run `hub task close {{key}}`. When it is `review`, release rungs remain ({{shipTo.remainingText}}): move `{{key}}` to `{{shipTo.closeState}}` with `{{tracker.actions.status}}` instead, because a task that stops short of production is finished by the operator.

When it is `ask`, release rungs remain ({{shipTo.remainingText}}) and this tracker has no review state. Leave `{{key}}` in its current state, ask the operator how to finish it with `orch workflow await`, and stop. When the operator has answered, do what the answer says and close this step on that ruling. Only the operator's answer closes it on this path.
