---
title: Research the existing system
stage: plan
floor:
  - recorded-artifact
job: null
autonomy: auto
needs:
  []
---
Read the implementation, project canon, and relevant documents before describing the change. Identify the files, services, data, interfaces, and existing patterns the work would touch; note what can be reused and where the current system contradicts the task's assumptions. Use external research only where local sources do not settle a material technical question, and preserve the sources and conclusion when you do.

Before a task exists, save the research summary to a file and run `orch workflow attach --cursor <cursor> --file <path>`. Close this step with the printed `attached-text:<id>` reference. The summary names the evidence inspected, the current behavior, the reusable seams, and every remaining uncertainty that affects design.
