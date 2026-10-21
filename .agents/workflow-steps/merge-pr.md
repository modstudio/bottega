---
title: Merge the pull request
stage: ship
floor:
  - command-exit
  - recorded-artifact
outcomes:
  - merged
  - merged-with-residue
expectedExitCodes:
  merged: 0
  merged-with-residue: 20
job: null
autonomy: ask
needs:
  - trunk
  - gate
  - release
  - reference
  - ship-to
---
The operator's ship-to level for this run is `{{shipTo.level}}`. When it is `branch`, the level stops at the pushed branch: do not merge. Record that the pull request is open and waiting for the operator with `bottega workflow await`, and stop.

Run `bottega gate check --enabled --project {{project}} --pr <link>` and proceed only when it exits zero. Then run `bottega pr merge <link> --cwd {{worktree}}`; it checks the pull request's declared remote proof or recorded local gate proof and merges with the registered method without deleting the head branch. It first repeats the review-admission check that `bottega pr create` runs and refuses when that check does not hold for the head commit; after a fix round, record the read of the new tip with `bottega review read --cwd {{worktree}} --note "<what was read after the fix>"` before merging. Map exit zero to outcome `merged`. Map exit status `20` to outcome `merged-with-residue`: the merge commit printed first is authoritative, but neither promotion nor task closing may proceed until the next cleanup step's retry succeeds. Any other nonzero status leaves this step open. If it refuses because a check is not passing, wait for the caller to clear the reported condition. A required check that was cancelled, timed out, or failed before any of the project's test or lint steps ran is an infrastructure failure; rerun its failed job once on the agent's authority. A second infrastructure failure of the same check stops the workflow and asks the operator with both run links. A failure inside the project's test or lint steps is real, is never rerun to green, and goes back to the branch owner. If `bottega pr merge` refuses because the landing branch moved, bring `{{branch}}` up to the landing branch in `{{worktree}}` by rebasing when it has no merge commit and is unpushed, and otherwise by merging; run the gate again through `bottega gate run` in the worktree, push, and run `bottega pr merge` again. Immediately after the merge, read each original run branch name with `bottega run result <run-id>`, then run `bottega tree branch landed <run-branch> --pr <number>` for every orch run branch whose work is in the pull request. When the shipped `{{branch}}` was not minted by an orch run, skip recording it and say that there is nothing to record for a branch no run minted. Probe the exact remote ref `refs/heads/{{branch}}`; delete only that remote head when it is present, and treat confirmed absence as done. On GitHub, run the probe from the main checkout with `git ls-remote --heads origin refs/heads/{{branch}}`: empty output confirms the head is absent, and any output means it is present and is deleted with `git push origin --delete {{branch}}`. Then update the main checkout from the remote.

Read the optional `reference` object from `facts`. When it is absent, record that the project declares no generated reference and skip publishing. When it is present, list the merged change's files exhaustively from the updated main checkout with `git diff --name-status -M <merged-commit>^1 <merged-commit>`, which covers squash and merge commits alike and is never paginated; if that list cannot be produced, stop and report rather than skip. Take each renamed or moved file's previous path as well as its current one, and compare the repository-relative paths against `reference.directory`, which the register stores in canonical form; a path is under the declared directory only when it equals the directory or starts with the directory followed by `/`. When no changed file is under that directory, record that the merged diff did not touch the generated reference and skip publishing. When at least one changed file is under the directory, run the command in `reference.publish` from the updated main checkout with `bottega workflow exec --cwd <main-checkout> -- <reference.publish>`, and record every per-page disposition printed by the command. A publish failure stops this workflow and is reported without reverting the merge.

This step is done only when the attribution check, `bottega pr merge`, landing-record, remote-head probe, and main-checkout update commands exit successfully, the merged pull request and resulting `{{trunk}}` commit are recorded, the remote head branch is gone, and, when reference publishing ran, its command exited successfully and its per-page dispositions were recorded.
