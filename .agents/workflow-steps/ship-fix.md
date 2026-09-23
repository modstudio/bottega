---
title: Fix accepted findings
stage: review
floor:
  - command-exit
  - recorded-artifact
job: implement
autonomy: ask
needs:
  []
---
Only if findings were accepted or modified, run `orch continue <original-run-id> "Fix the accepted review findings."`. Then loop back to `lens`, because the tree changed.
