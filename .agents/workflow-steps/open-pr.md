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
Push `{{branch}}` from `{{worktree}}`, then open the pull request with `bottega pr create`; it sets the base to `{{trunk}}` itself and refuses `--base`. Its body states what changed, why it changed, and the successful gate command and result. After opening it, run `bottega gate check --enabled --project {{project}} --pr <link>`.

This step is done only when the push, pull-request, and attribution-check commands exit successfully and the recorded pull-request link names `{{branch}}` as its head and `{{trunk}}` as its base.
