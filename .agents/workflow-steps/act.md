---
title: Perform the confirmed operation
stage: implement
floor:
  - recorded-artifact
jobs: []
autonomy: auto
needs: []
---
Perform only the writes individually approved in the preceding confirmation step (`confirm-write` or `confirm-production-write`), through the target system's declared tools. Before each write, compare its target and effect with that step's recorded confirmation. Stop before an unlisted or changed write; it needs a new confirmation and cannot be folded into the current action.

Read back each changed resource and record the before state, the confirmed write, and the resulting state. This step is done when every confirmed write has either been applied and verified or recorded as not attempted with the reason.
