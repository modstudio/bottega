---
title: Investigate the subject
stage: plan
floor:
  - recorded-artifact
jobs: [understand, file-question, mcp-query, diagnose]
autonomy: auto
needs: []
---
Investigate the framed question, change, or task with the smallest lookup that can settle each uncertainty. Dispatch the `understand`, `file-question`, `mcp-query` and `diagnose` jobs to read the repository, answer a question from supplied files, query an external system through its declared tools, and establish the cause of broken behavior, respectively. Dispatch only jobs the evidence requires, and change nothing.

Record the sources read, the evidence each lookup established, and what remains unknown. This step is done when every uncertainty in the frame is answered or explicitly recorded as unresolved with the reason it could not be checked.
