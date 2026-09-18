---
title: Start the task
floor:
  - tracker-transition
job: null
autonomy: auto
needs:
  - tracker
  - worktree
---
Use this project's tracker to move the task into its `{{tracker.states.active}}` state with `{{tracker.actions.status}}` and assign it according to the project's normal policy. Read the current state immediately before changing it with `{{tracker.actions.get}}` rather than trusting an earlier copy. Then use the project's registered worktree recipe to create the isolated branch and worktree for the exact key the tracker returned; use the recipe's own naming, base, install, and environment rules.

This step is done only when a tracker read-back proves the task reached the active state. Report the resulting key and worktree location for the implementation handoff.
