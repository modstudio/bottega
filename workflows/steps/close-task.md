---
title: Close the task
floor:
  - tracker-transition
job: null
autonomy: auto
needs:
  - release
  - tracker
---
At the last release rung reached, or after merge when `facts.release.rungs` is empty, move `{{key}}` in the {{tracker.kind}} tracker through {{tracker.protocol}} to `{{tracker.states.done}}` with `{{tracker.actions.status}}`. Add the pull request link to the task with `{{tracker.actions.update}}`, then read the task back with `{{tracker.actions.get}}`.

This step is done only when the read-back shows `{{key}}` in `{{tracker.states.done}}` and the task record contains the pull request link.
