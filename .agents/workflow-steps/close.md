---
title: Close the session workflow
stage: plan
floor:
  - ruling
outcomes:
  - answered
  - graduated
  - noted
  - expired
jobs: []
autonomy: auto
needs: []
---
Choose the disposition supported by the workflow's record.

- Close with `answered` when the question or work is complete and no task or note is needed.
- Close with `graduated` when the findings warrant planned work. Copy explore's findings with `bottega workflow text copy --cursor <cursor> --task <KEY>`, then compose `plan-task` for that key. That workflow still performs its own targeted discover and research steps.
- Close with `noted` when the observation should remain visible without becoming current work. File it with `bottega note new`, then record the note returned by the command.
- `expired` is reserved to `bottega machine sweep`. An agent never chooses it.

Do not close with a disposition whose required action has not completed. Record the chosen disposition and its evidence in the ruling that closes this step.
