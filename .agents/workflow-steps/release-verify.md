---
title: Verify the release writing probe
stage: review
floor:
  - command-exit
jobs: []
autonomy: auto
needs: []
---
Check that the writing run's shared ref guard is outside its worktree and that the run's branch contains the expected commit. Run both checks through `bottega workflow exec -- <command>` and close this step with `--artifact exec:<id>` only when they pass.
