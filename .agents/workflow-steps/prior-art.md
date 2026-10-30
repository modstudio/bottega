---
title: Survey prior art
stage: plan
floor:
  - recorded-artifact
job: null
autonomy: auto
needs: []
---
Survey how libraries, engines, design platforms, and other products solve the same need. This step studies outside solutions rather than this project's code, which `research` owns, and records possibilities rather than choosing among them, which `design` owns. The resulting design remains our own.

Save a record that names every source consulted, what it suggested, and whether its idea was taken. Save the record to a file and run `bottega workflow attach --cursor <cursor> --file <path>`. Close this step with the printed `attached-text:<id>` reference.

On the fix path this step runs only after `recurrence` closed with `original-fix-wrong`. A fix whose `recurrence` closed with `new-symptom` skips this step.
