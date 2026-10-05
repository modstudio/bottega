---
title: Close the task
stage: ship
floor:
  - tracker-transition
job: null
autonomy: auto
needs:
  - release
  - tracker
---
When `facts.release.rungs` names a rung this run did not reach, the task is not done. Do not move `{{key}}` to `{{tracker.states.done}}`: record the pull request link on the task, leave this step open, and tell the operator which rungs remain.

At the last release rung reached, or after merge when `facts.release.rungs` is empty, move `{{key}}` in the {{tracker.kind}} tracker through {{tracker.protocol}} to `{{tracker.states.done}}` with `{{tracker.actions.status}}`. Record the pull request link on the task through the tracker named in `facts`, as a comment where the tracker has one and otherwise in the task's description, then read the task back with `{{tracker.actions.get}}`.

This step is done only when the read-back shows `{{key}}` in `{{tracker.states.done}}` and the task record contains the pull request link.
