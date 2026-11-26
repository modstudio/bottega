---
description: Product boundaries, research duties, review budget, and failure-class measurement
always: true
---

# Build, buy and measure

## Build only the product

Build the routing algorithm and evidence model, worker contract and escalation,
review composition and calibration, canon and context injection, attribution,
and the task and workflow surfaces other projects consume.

Buy established plumbing. Prefer mechanisms already run in production on this
machine for authentication and organizations, database access and migrations,
tenancy enforcement, transports, queues, object storage and hosting. A
hand-rolled mechanism where a maintained one exists is a defect: name and
replace it rather than extending it.

Preserve the value proposition, not incidental machinery. A subsystem that is
neither product nor bought plumbing is a liability to replace, however much of
it exists.

Biome owns TypeScript, TSX and JSON formatting and lint rules. Change
`biome.jsonc` rather than suppressing an enforced rule.

## Research before specifying every task

The architect researches current practice and maintained solutions before
specifying and dispatching work. This cannot be delegated to a networkless
worker or answered from memory. Give the worker the conclusion as a ruling,
not the research question.

Separate novel product behavior from its ordinary internal machinery because
the halves usually have different build-or-buy answers. Record negative
results in the specification so later work does not repeat the search.

## Review rounds follow the funnel

`bottega review tier` is the authority on what lenses a change owes and whether another round may run.
Dispatch exactly what it lists. Fix real findings in their round; drop speculation in triage.

At the round ceiling the architect rules: if no finding left can cause harm,
land with test-only fixes and file the rest.

Respect the orchestration policy's review concurrency ceiling.

When a gate
cannot run, record why and land on the evidence available; do not spend
another turn re-presenting an unchanged recommendation.

## Measure the class before fixing an instance

Build the surface that measures a failure class before repairing the newest
example. In an epic, schedule that surface first. A proposed fix cites the
measurement command's current output, and a landed fix reports what the same
surface shows afterwards.

A worker has no network; repeat its timings that cross one from the main
checkout.

A fix lands with a guard that stops or flags its whole class, named in its task
and pull request; without one it is instance patching. The guard states its
measured time, per the caution rule.
