---
title: Dispatch the release writing probe
stage: implement
floor:
  - command-exit
jobs: [implement]
autonomy: auto
needs: []
---
Start the release's writing probe with `bottega workflow dispatch implement --cursor <cursor> "Make the release smoke fixture commit."`. Close this step with `--run <run>` only after the run finishes successfully.
