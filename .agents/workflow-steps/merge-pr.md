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
Read the required check names from `facts.release.requiredChecks` in the composition and wait for every named check to pass. Run `orch check --enabled --project {{project}} --pr <link>` and proceed only when it exits zero. Then merge the pull request into `{{trunk}}` with the `{{release.mergeMethod}}` method, using the pull request's title as the commit subject, without deleting the head branch as part of the merge. Immediately after the merge, run `orch branches landed {{branch}} --pr <number>`. Then delete only the remote head branch with the provider's own remote-branch deletion (on GitHub, from the main checkout: `git push origin --delete {{branch}}`), then update the main checkout from the remote.

This step is done only when the check-wait, attribution-check, merge, landing-record, remote-head deletion, and main-checkout update commands exit successfully, the merged pull request and resulting `{{trunk}}` commit are recorded, and the remote head branch is gone.
