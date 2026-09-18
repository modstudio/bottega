---
title: File the report
floor:
  - recorded-artifact
job: null
autonomy: auto
needs:
  - tracker
  - docs
---
File one issue in the composing project's {{tracker.kind}} tracker through {{tracker.protocol}}, using the recorded restatement unchanged as the issue body. When the target project is bottega, use the orch MCP `file_issue` tool; for every other project, use `{{tracker.actions.create}}`. Preserve the key returned by the tracker rather than guessing it, and record the near-duplicate keys found earlier on the issue or in its links.

Write a Findings document only when the investigation produced evidence beyond the raw report text. Choose the findings-document write action from `facts.docs.write`, keep the issue body's evidence summary intact, and put the additional investigation evidence in that document. Write a separate task document only when the tracker description cannot carry the restatement; choose its write action from the same facts rather than naming a project-specific tool.

This step is done when the created issue key and body are recorded, the body matches the restatement, every near duplicate is recorded, and each conditionally required document is linked to the issue. Then stop: planning and fixing belong to their own workflows.
