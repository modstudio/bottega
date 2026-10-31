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

Otherwise read each listed rung from `facts.release.rungs` and promote to its branch in order. A rung whose branch is the landing branch has nothing to promote and only runs its deploy. A rung without a deploy only promotes. Otherwise, promote and then run `bottega release run <project> --rung <name>` from the registered main checkout. Confirm the rung before moving to the next. This step is done only when every promotion and declared deploy command for the listed rungs exits successfully and a recorded result confirms each reached rung.
