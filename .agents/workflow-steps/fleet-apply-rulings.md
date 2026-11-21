---
title: "Apply the user's rulings"
stage: plan
floor:
  - ruling
operatorRuling: true
jobs: []
autonomy: ask
needs: []
---
Present the proposed agent changes from the report and ask the user to accept, change or decline each one. Apply only what the user accepts, using the recorded commands, so each disabled reason carries its evidence and its re-enable command.

This step is done only when a ruling recorded with `--from-operator` names each proposed change and its disposition, and `bottega agent list` shows the accepted changes.
