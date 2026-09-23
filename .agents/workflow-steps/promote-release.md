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
Read the ordered promotion ladder from `facts.release.rungs` in the composition. Promote to each rung's branch in order, through and including the rung named by the optional depth argument when it is given; when depth is absent, continue through every rung. A rung whose branch is the landing branch has nothing to promote and only runs its deploy. A rung without a deploy only promotes. Otherwise, promote and then run the rung's deploy command. Confirm the rung before moving to the next. If depth names no rung, stop and report the mismatch instead of choosing one.

When `facts.release.rungs` is empty, promotion is complete at merge; record that there was no rung to promote. Otherwise, this step is done only when every promotion and declared deploy command through the resolved depth exits successfully and a recorded result confirms each reached rung.
