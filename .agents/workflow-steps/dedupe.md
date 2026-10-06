---
title: Check for existing work and decisions
stage: plan
floor:
  - ruling
  - recorded-artifact
job: null
autonomy: ask
needs:
  - tracker
  - docs
---
Before research, search both this project's {{tracker.kind}} tracker through {{tracker.protocol}} with `{{tracker.actions.search}}` and its document store through {{docs.protocol}}. Search two or three phrasings that another person might have used, including the specific object and action, a broader topic, and any named identifier.

Classify each result as the same outcome, an active conflict, a related task, a prior decision, or unrelated. Present the relevant matches and their relationship to the request. If there is a duplicate, conflict, or prior decision that changes the work, stop for a ruling on whether to reuse it, merge scope, link it and continue, or abandon the request.

When the searches find nothing, attach a note naming what was searched with `orch workflow attach --cursor <cursor> --file <path>` and close this step with the printed `attached-text:<id>` reference. When a duplicate, conflict, or prior decision is found, a ruling is required; an artifact alone does not settle it.
