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
---
The operator's level bounds this step. Read the session-start autonomy line that states how far a change may go without the operator. Unless that line allows promotion to production, promote no rung and run no deploy: record on the task, as a comment, that the operator's level stops before promotion, naming the level, and close the step on that comment as its recorded artifact. A command exit is not evidence on this path. This step's own autonomy never grants promotion. If the session carries no such line, stop and ask the operator instead of assuming a level.

When the level allows promotion, read the ordered promotion ladder from `facts.release.rungs` in the composition. Promote to each rung's branch in order, through and including the rung named by the optional depth argument when it is given; when depth is absent, continue through every rung. A rung whose branch is the landing branch has nothing to promote and only runs its deploy. A rung without a deploy only promotes. Otherwise, promote and then run `orch release <project> --rung <name>` from the registered main checkout. Confirm the rung before moving to the next. If depth names no rung, stop and report the mismatch instead of choosing one.

When `facts.release.rungs` is empty, promotion is complete at merge; record that there was no rung to promote. Otherwise, when the level allows promotion, this step is done only when every promotion and declared deploy command through the resolved depth exits successfully and a recorded result confirms each reached rung.
