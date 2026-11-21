---
title: "Check the task's acceptance criteria"
stage: review
floor:
  - recorded-artifact
  - ruling
outcomes:
  - settled
  - owed
operatorRuling: true
jobs: []
autonomy: auto
needs:
  - release
  - tracker
---
Review asks whether the code is good; this step asks whether the right thing was built. Work can be clean, typed and reviewed and still not be what the task asked for, so both must pass.

Read `{{key}}` with `{{tracker.actions.get}}` and take each acceptance criterion in turn. An unmarked criterion is observable now. Its verdict is met, not met, or accepted unverified. A criterion that names the gate is met by the gate execution recorded in the previous step. A criterion with no evidence is not met unless the user accepts it unverified. An agent cannot grant accepted unverified at any autonomy level. Before writing an accepted-unverified verdict, record a ruling with `--from-operator` against this step that names every criterion it accepts unverified.

A marked criterion declares its first observable point with exactly one marker: `[after: pr-ci]`, `[after: landed]`, or `[after: rung <name>]`. It must name the command or probe that will check it. A marked criterion without a named check is not met; record that the criterion must name its command or probe, and stop. A rung marker must name a rung declared in `facts.release.rungs`; an undeclared rung is not met, and its remedy names the declared rungs. Merge mode cannot reach a rung judging step, so any rung marker in merge mode is not met and its remedy is to compose `ship-task` in full mode. Do not record any of these refused criteria as owed.

Record every valid marked criterion as owed, with its marker's point and named check. Do not judge it at acceptance. Record a table of every criterion, its verdict, observation point, named check, and evidence with `{{tracker.actions.comment}}`. Include the accepted-unverified list. When that action is `bottega workflow attach`, save the table to a file, run `bottega workflow attach --cursor <cursor> --file <path>`, and close this step with the printed `attached-text:<id>` reference. Otherwise write the table to `{{key}}` as a tracker comment and close with `--artifact task:{{key}}`. Close with outcome `owed` when the table contains at least one owed criterion, and with `settled` otherwise. This step is done only when every unmarked criterion is met or accepted unverified and every marked criterion is valid. A not-met criterion stops the flow and goes back to the implementer.
