---
title: Merge the pull request
stage: ship
floor:
  - command-exit
  - recorded-artifact
job: null
autonomy: ask
needs:
  - trunk
  - release
---
Read the required check names from `facts.release.requiredChecks` in the composition and wait for every named check to pass. Run `orch check attribution --pr <link>` and proceed only when it exits zero. Then merge the pull request into `{{trunk}}` with the `{{release.mergeMethod}}` method and update the main checkout from the remote.

This step is done only when the check-wait, attribution-check, merge, and main-checkout update commands exit successfully and the merged pull request and resulting `{{trunk}}` commit are recorded.
