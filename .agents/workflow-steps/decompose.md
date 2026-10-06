---
title: Decompose the work
stage: plan
floor:
  - recorded-artifact
job: null
autonomy: auto
needs:
  []
---
Turn the chosen solution into concrete, reviewable work. Prefer independent vertical slices that deliver behavior end to end over horizontal layers. Split work by what can be reviewed and rolled back coherently, not by an estimate of elapsed time.

For every step or child task, record the deliverable, the files or domain where it belongs, its dependencies, and pass/fail acceptance criteria. Identify ordering constraints, risky migrations, characterization tests, rollout and rollback points, and which slices can proceed independently. If the result contains more than one review or rollback unit, propose separate linked tasks rather than hiding multiple outcomes in one task.

Before a task exists, save the complete breakdown to a file and run `orch workflow attach --cursor <cursor> --file <path>`. Close this step with the printed `attached-text:<id>` reference. Every slice has a clear dependency and acceptance boundary.
