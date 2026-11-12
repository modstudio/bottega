---
title: Confirm every write
stage: implement
floor:
  - ruling
job: null
autonomy: ask
needs: []
---
List every proposed write separately, including its target, exact effect, reversibility, and why it is needed. The session's resolved autonomy level decides who may confirm each write. A production target belongs in operate's `production` mode instead of this step.

The confirmation covers only the listed writes. Revise the list and obtain a new confirmation before performing any write whose target or effect changes. This step is done when every write proposed for `act` has been confirmed at the required level.
