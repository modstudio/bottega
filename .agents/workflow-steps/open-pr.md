---
title: Open the pull request
stage: ship
floor:
  - command-exit
  - recorded-artifact
job: null
autonomy: ask
needs:
  - trunk
---
Push `{{branch}}` from `{{worktree}}`, then open a pull request from the pushed remote branch against `{{trunk}}`. Its body states what changed, why it changed, and the successful gate command and result. After opening it, run `orch check --enabled --project {{project}} --pr <link>`.

This step is done only when the push, pull-request, and attribution-check commands exit successfully and the recorded pull-request link names `{{branch}}` as its head and `{{trunk}}` as its base.
