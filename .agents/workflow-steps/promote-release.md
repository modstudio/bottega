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
---
The operator's ship-to level bounds this step. `facts.shipTo.reach` lists the release rungs this run may promote, in order: {{shipTo.reachText}}. Promote no other rung and run no other deploy. This step's own autonomy never widens that list.

When the list is empty there is nothing to promote: record on the task, as a comment, that ship to is `{{shipTo.level}}` and which rungs remain ({{shipTo.remainingText}}), and close the step on that comment as its recorded artifact. A command exit is not evidence on this path.

Otherwise read each listed rung from `facts.release.rungs` and promote to its branch in order. A rung whose branch is the landing branch has nothing to promote and only runs its deploy. A rung without a deploy only promotes. Otherwise, promote and then run `orch release <project> --rung <name>` from the registered main checkout. Confirm the rung before moving to the next. This step is done only when every promotion and declared deploy command for the listed rungs exits successfully and a recorded result confirms each reached rung.
