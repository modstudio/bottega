---
title: Diagnose
stage: plan
floor:
  - recorded-artifact
job: diagnose
autonomy: auto
needs:
  - tracker
---
Dispatch `orch do diagnose --key {{key}} "Diagnose {{key}}: read it with {{tracker.actions.get}}, establish its cause with file:line evidence, and change nothing."` and establish the cause before editing.

Compare the investigation evidence with the task text. Write a Findings document only when the investigation produced evidence beyond what the task already records, using the document action named by `facts.tracker.actions.document` in the composition. When the composed tracker facts carry no document action, skip the Findings document and record that missing action as the reason. When the investigation added no evidence beyond the task text, record that no Findings document was needed.

This step is done when the diagnosis is recorded and the conditional Findings-document disposition is recorded.
