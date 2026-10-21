---
title: Mark the task in review
stage: review
floor:
  - "{{tracker.inReview.floor}}"
expectedStatus: "{{tracker.inReview.state}}"
job: null
autonomy: auto
needs:
  - tracker
---
Read the task's current state with `{{tracker.actions.get}}` immediately before changing it. The composition's `facts.tracker.inReview` names the state and floor for this project. When the floor is `tracker-transition`, move the task to the in-review state with `{{tracker.actions.status}}`, then read it back with `{{tracker.actions.get}}`. This path is done only when the read-back proves the task reached the in-review state.

When the floor is `recorded-artifact`, either the project declares no review state or its declared review-record command writes the review state after the review. Leave the task in its current state and record which case applies through the comment action named by `facts.tracker.actions.comment`, or in the task description when the tracker has no comment action. Close the step on that recorded artifact.
