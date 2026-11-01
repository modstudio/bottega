---
title: Choose the solution
stage: plan
floor:
  - ruling
outcomes:
  - schema-or-names
  - neither
job: null
autonomy: ask
needs: []
---
Begin only after the requirements are locked and the existing system has been researched. Develop at least two genuinely different approaches wherever the solution space allows it. For each, explain how it fits the existing system, its complexity, coupling, migration and compatibility risks, what it forecloses, and how it can be rolled back. Do not present cosmetic variations as separate choices.

For each new piece of state, decide where it lives and cite its `hosted-first`, `evidence` or `machine-only` class in `scripts/identity-state-classes.ts`. A new local table adds its declaration there.

On the fix path this step runs only after `recurrence` closed with `original-fix-wrong`: rethink the fix that did not hold, in full. A fix whose `recurrence` closed with `new-symptom` skips this step.

Recommend one approach and explain why it best satisfies the locked requirements and project canon. Where the operator rules, every material design fork goes to the operator. Where the agent rules, a fork that changes what the user sees, or product direction, still goes to the operator; the agent rules every other fork and records the ruling.

List every database change in the chosen design, including schemas, tables, columns, keys, and migrations, or write `none`. List every new significant name, including public APIs, CLI verbs and flags, attributes, properties, messages, events, tables, and packages, or write `none`. Internal identifiers are not significant names. Close with `schema-or-names` when either list contains an entry and with `neither` only when both lists say `none`.

This step is done only when an approach is chosen, every material design fork has a recorded ruling, and both lists are complete. Record the chosen direction and rejected alternatives for the task text when they remain useful to implementation.
