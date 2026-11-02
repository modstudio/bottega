---
title: "Check the task's acceptance criteria"
stage: review
floor:
  - recorded-artifact
  - ruling
operatorRuling: true
job: null
autonomy: auto
needs:
  - tracker
---
Review asks whether the code is good; this step asks whether the right thing was built. Work can be clean, typed and reviewed and still not be what the task asked for, so both must pass.

Read `{{key}}` with `{{tracker.actions.get}}` and take each acceptance criterion in turn. Each verdict is met, not met, or accepted unverified. A criterion that names the gate is met by the gate execution recorded in the previous step. A criterion with no evidence is not met unless the operator accepts it unverified. An agent cannot grant accepted unverified at any autonomy level. Before writing an accepted-unverified verdict, record a ruling with `--from-operator` against this step that names every criterion it accepts unverified.

Record a table of every criterion, its verdict, and its evidence with `{{tracker.actions.comment}}`. Include the accepted-unverified list. When that action is `bottega workflow attach`, save the table to a file, run `bottega workflow attach --cursor <cursor> --file <path>`, and close this step with the printed `attached-text:<id>` reference. Otherwise write the table to `{{key}}` as a tracker comment and close with `--artifact task:{{key}}`. This step is done only when every criterion is met or accepted unverified. A not-met criterion stops the flow and goes back to the implementer.
