---
title: Start the task
stage: plan
floor:
  - tracker-transition
expectedStatus: "{{tracker.states.active}}"
jobs: [implement]
autonomy: auto
needs:
  - tracker
---
Read the current state and assignee with `{{tracker.actions.get}}` immediately before changing the task rather than trusting an earlier copy. Keep the assignee that read returns. When the task is unassigned, follow the assignment rule in the project's own canon under its task-lifecycle rules. When the project's canon states no assignment rule, leave the task unassigned and say so in the step's closing note. Use this project's tracker to move the task into its `{{tracker.states.active}}` state with `{{tracker.actions.status}}`, then read it back with `{{tracker.actions.get}}` after changing it.

When the task's scope no longer fits the current mode after the task is written, abandon the cursor with `bottega workflow abandon --cursor <cursor> --reason "<why the mode no longer fits>"`, then compose `plan-task` again in the fitting mode with the existing task key passed as its `key` argument.

After the tracker read-back proves the task reached the active state, dispatch the implementation with `bottega workflow dispatch implement --cursor <cursor> "Implement <key> as the task records it."`; the implementation run builds the change and provisions its own worktree. Keep this step open while that run builds. Collect its result, read and judge the delivered change, and record its score.

This step is done only when the implementation run is terminal and its result has been judged and scored. Hand the still-claimed task to shipping with `bottega workflow handoff ship-task --mode full --cursor <cursor> --arg key=<key> --arg branch=<the implementation run's branch> --arg worktree=<its architect tree from bottega tree open> --reason "build done"`; do not close it with `bottega workflow next`.
