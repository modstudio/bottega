---
title: "Check the task's acceptance criteria"
floor:
  - recorded-artifact
job: null
autonomy: auto
needs:
  - tracker
---
Review asks whether the code is good; this step asks whether the right thing was built. Work can be clean, typed and reviewed and still not be what the task asked for, so both must pass.

Read `{{key}}` with `{{tracker.actions.get}}` and take each acceptance criterion in turn. For each, record the criterion, the evidence on the branch that meets it (a test, a command and its result, or the changed behaviour), and a verdict of met, partial, or not met. A criterion with no evidence is not met.

This step is done only when the recorded table covers every criterion and every verdict is met. A partial or unmet criterion stops the flow and goes back to the implementer or to the operator for a ruling.
