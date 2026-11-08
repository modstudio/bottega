---
title: Promote the release
stage: ship
floor:
  - command-exit
  - recorded-artifact
job: null
autonomy: ask
needs:
  - release
  - ship-to
  - tracker
  - merged-change
---
The operator's ship-to level bounds this step. `facts.shipTo.reach` lists the release rungs this run may promote, in order: {{shipTo.reachText}}. Rungs in `facts.shipTo.skipped` carry no release artifact in this change ({{shipTo.skippedText}}); run nothing for them, and name each with its reason in the task comment. Promote no other rung and run no other deploy. This step's own autonomy never widens that list.

When the list is empty there is nothing to promote: record that ship to is `{{shipTo.level}}` and which rungs remain ({{shipTo.remainingText}}) with `{{tracker.actions.comment}}`. When that action is `bottega workflow attach`, save the note to a file, run `bottega workflow attach --cursor <cursor> --file <path>`, and close this step with the printed `attached-text:<id>` reference. Otherwise write the note as a tracker comment and close on that task evidence. A command exit is not evidence on this path.

Otherwise read each listed rung from `facts.release.rungs` and promote to its branch in order. Every rung that declares a deploy command must also declare a live probe that prints the commit the running deployment was built from, not a reachability check. For a reached rung, run `bottega release run <project> --rung <name>` from the registered main checkout. A rung is proved live only when its live probe observes the candidate commit. When the probe already contains the candidate before any deploy or wait, the command reports it as already live and deploys nothing; if the landing branch has newer commits that are not on the rung branch, promote them first. A rung whose branch is the landing branch has nothing to promote and only runs its deploy when it is not already live. For a rung without a deploy command, promote by pushing the landing branch's merge into the rung branch as the project's release process does, then run `bottega release run <project> --rung <name>`; the command waits on the rung's live probe and records the proof. When a rung does not declare a live probe, record the register remedy printed by the command and stop this step. Otherwise, promote and then run `bottega release run <project> --rung <name>` from the registered main checkout. Confirm the rung before moving to the next. This step is done only when every promotion and still-needed declared deploy command exits successfully and a live observation confirms each reached rung.
