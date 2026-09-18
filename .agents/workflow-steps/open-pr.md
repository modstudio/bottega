---
title: Open the pull request
floor:
  - command-exit
  - recorded-artifact
job: null
autonomy: ask
needs:
  - trunk
---
Push `{{branch}}` from `{{worktree}}`, then open a pull request from the pushed remote branch against `{{trunk}}`. Its body states what changed, why it changed, and the successful gate command and result.

This step is done only when the push and pull-request command exit successfully and the recorded pull-request link names `{{branch}}` as its head and `{{trunk}}` as its base.
