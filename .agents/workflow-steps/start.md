---
title: Start the task
stage: plan
floor:
  - tracker-transition
job: null
autonomy: auto
needs:
  - tracker
---
Use this project's tracker to move the task into its `{{tracker.states.active}}` state with `{{tracker.actions.status}}` and assign it according to the project's normal policy. Read the current state immediately before changing it with `{{tracker.actions.get}}` rather than trusting an earlier copy, then read it back with `{{tracker.actions.get}}` after changing it.

This step is done only when the tracker read-back proves the task reached the active state. Report the resulting key for the implementation handoff. The implementation dispatch provisions the worktree.
