---
title: Pick one defect
floor:
  - recorded-artifact
job: null
autonomy: auto
needs:
  - tracker
---
A run fixes exactly one item. Work through the sources in order, moving to the next only when the current one yields nothing fixable:

1. Open tasks from `{{tracker.actions.search}}` that report broken behaviour. Skip a task in the tracker's active state, and one with a live orch run or an unanswered question (`orch inbox`). Prefer the oldest.
2. Current conditions from `orch monitor` for this project that need a code change. Residue that monitor or `orch reclaim` releases is not a defect.
3. Recent failed runs from `orch runs` whose failure is attributed to orch or the harness rather than to the agent.
4. Actionable notes from `hub note list --project <project> --actionable`. Promotion is a person's act: record the chosen note, ask the operator to run `hub note promote <id>`, and stop until they have.

An item from source 2 or 3 is filed first with `{{tracker.actions.create}}`. Record the chosen item, its task key and one line on why each earlier source yielded nothing, on the chosen task with the comment action named by `facts.tracker.actions.comment`, substituting the chosen key. Then close this step with `orch workflow next`, which finishes the auto run, and only then compose `fix-defect` in mode `single` with that key and continue there. When every source is empty, report that nothing needs fixing and finish.

This step is done when the chosen key and the per-source record exist, or when an empty result across all four sources has been reported.
