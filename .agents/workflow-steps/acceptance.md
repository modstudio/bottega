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

Read `{{key}}` with `{{tracker.actions.get}}` and take each acceptance criterion in turn. Each verdict is met, not met, or accepted unverified. A criterion that names the gate is met by the gate execution recorded in the previous step. A criterion with no evidence is not met unless the operator accepts it unverified. An agent cannot grant accepted unverified at any autonomy level. Before writing an accepted-unverified verdict, record an operator ruling against this step that names every criterion it accepts unverified.

Write a table of every criterion, its verdict, and its evidence to `{{key}}` in the project's tracker as a comment or task document. Include the accepted-unverified list. Close this step with that task evidence. This step is done only when every criterion is met or accepted unverified. A not-met criterion stops the flow and goes back to the implementer.
