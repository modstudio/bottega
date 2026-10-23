---
title: Mark the task waiting for review
stage: ship
floor:
  - "{{tracker.waitingReview.floor}}"
expectedStatus:
  - "{{tracker.waitingReview.state}}"
  - "{{tracker.inReview.state}}"
job: null
autonomy: auto
needs:
  - tracker
---
Read the task's current state with `{{tracker.actions.get}}` immediately before changing it. The composition's `facts.tracker.waitingReview` names the state and floor for this project. When the floor is `tracker-transition`, leave the task unchanged when it is already in that state or in the state named by `facts.tracker.inReview`; otherwise move it to the waiting-review state with `{{tracker.actions.status}}`. Read the task back with `{{tracker.actions.get}}` after the decision. This path is done only when the read-back shows the task in the waiting-review or in-review state.

When the floor is `recorded-artifact`, the project declares no review state. Leave the task in its current state and record that fact with `{{tracker.actions.comment}}`. When that action is `bottega workflow attach`, save the note to a file, run `bottega workflow attach --cursor <cursor> --file <path>`, and close this step with the printed `attached-text:<id>` reference. Otherwise write the note as a tracker comment and close on that task evidence.
