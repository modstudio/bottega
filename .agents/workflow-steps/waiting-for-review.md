---
title: Mark the task waiting for review
stage: ship
floor:
  - "{{tracker.waitingReview.floor}}"
outcomes:
  - review
  - slice
outcomeFloors:
  slice:
    - task-open-with-notes
expectedStatus:
  - "{{tracker.waitingReview.state}}"
  - "{{tracker.inReview.state}}"
jobs: []
autonomy: auto
needs:
  - tracker
---
Read the task's current state with `{{tracker.actions.get}}` immediately before changing it. The composition's `facts.tracker.waitingReview` names the state and floor for this project. When the floor is `tracker-transition`, leave the task unchanged when it is already in that state or in the state named by `facts.tracker.inReview`; otherwise move it to the waiting-review state with `{{tracker.actions.status}}`. Read the task back with `{{tracker.actions.get}}` after the decision. This path is done only when the read-back shows the task in the waiting-review or in-review state.

When the floor is `recorded-artifact`, the project declares no review state. Leave the task in its current state and record that fact with `{{tracker.actions.comment}}`. When that action is `bottega workflow attach`, save the note to a file, run `bottega workflow attach --cursor <cursor> --file <path>`, and close this step with the printed `attached-text:<id>` reference. Otherwise write the note as a tracker comment and close on that task evidence. Close either review path with `bottega workflow next` for this cursor's workflow, `--outcome review`, and the evidence its floor requires.

When this cursor ships one slice of a task that stays open, leave the task in its current open, active or review state. Close with `bottega workflow next` for this cursor's workflow, `--task {{key}} --outcome slice`, and one `--artifact note:<record-id>` or `--artifact note:<project>#<number>` for every remaining open note attached to the task.
