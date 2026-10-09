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
  - ship-to
---
The operator's ship-to level for this run is `{{shipTo.level}}`. When it is `branch`, the level stops at the pushed branch: do not merge. Record that the pull request is open and waiting for the operator with `orch workflow await`, and stop.

Read the required check names from `facts.release.requiredChecks` in the composition and wait for every named check to pass. A required check that was cancelled, timed out, or failed before any of the project's test or lint steps ran is an infrastructure failure. Rerun its failed job once on the agent's authority. A second infrastructure failure of the same check stops the workflow and asks the operator with both run links. A failure inside the project's test or lint steps is real: never rerun it to green, and return it to the branch owner.

Before the attribution check and merge, fetch `origin/{{trunk}}` in `{{worktree}}`, identify the commit on which the recorded passing gate ran, and compare the remote trunk tip with that commit's merge base. When they differ, remote trunk has moved: bring `{{branch}}` up to that tip in the worktree by rebasing when the branch has no merge commit and is unpushed, and otherwise by merging `origin/{{trunk}}`. Run the gate again on the resulting tip, record that passing execution, and push the updated branch before proceeding. A gate run from before trunk moved does not admit the merge.

Run `orch check --enabled --project {{project}} --pr <link>` and proceed only when it exits zero. Then merge the pull request into `{{trunk}}` with the `{{release.mergeMethod}}` method, using the pull request's title as the commit subject, without deleting the head branch as part of the merge. Immediately after the merge, read each original run branch name with `orch result <run-id>`, then run `orch branches landed <run-branch> --pr <number>` for every orch run branch whose work is in the pull request. When the shipped `{{branch}}` was not minted by an orch run, skip recording it and say that there is nothing to record for a branch no run minted. Probe the exact remote ref `refs/heads/{{branch}}`; delete only that remote head when it is present, and treat confirmed absence as done. On GitHub, run the probe from the main checkout with `git ls-remote --heads origin refs/heads/{{branch}}`: empty output confirms the head is absent, and any output means it is present and is deleted with `git push origin --delete {{branch}}`. Then update the main checkout from the remote.

This step is done only when the check-wait, attribution-check, merge, landing-record, remote-head probe, and main-checkout update commands exit successfully, the merged pull request and resulting `{{trunk}}` commit are recorded, and the remote head branch is gone.
