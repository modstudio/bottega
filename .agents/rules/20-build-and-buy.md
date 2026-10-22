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
neither product nor bought plumbing is a liability and should be replaced even
when much of it already exists.

Biome owns TypeScript, TSX and JSON formatting and lint rules. Change
`biome.jsonc` rather than suppressing an enforced rule.

## Research before specifying every task

The architect researches current practice and maintained solutions before
specifying and dispatching work. This cannot be delegated to a networkless
worker or answered from memory. Give the worker the conclusion as a ruling,
not the research question.

Separate novel product behavior from its ordinary internal machinery because
the halves usually have different build-or-buy answers. Record negative
results in the specification so later work does not pay to repeat the same
search.

## Review rounds are a funnel

`review-tier-classifier.ts:classifyReviewTier` sets a change's combined tier from path
risk and cognitive size. A size-`0` change lowers its path's risk by one, except on a
risk-map path marked `firm`. The project's declaration selects its lenses, and
tier `0` runs none. Check the tier before every round.

The initial review is the only full review. A later round runs only when a
tier `3` fix touched a tier `3` path, as a regression check: only the lenses
with accepted findings, plus any whose paths it newly touched. A clean lens
drops out for good; a round with no accepted findings ends the ladder.
Dispatch only what the funnel admits, not all `bottega review tier` lists.
Otherwise the architect reads the fix and lands it. Fix real findings in
their round; drop speculation in triage.

A well-sized change leaves by its third round. At the ceiling the architect
rules: if no finding left can cause harm, land with test-only fixes and file
the rest.

Respect the review concurrency ceiling defined by the orchestration policy.
When a gate cannot run, record why and land on the evidence available; do not
spend another turn re-presenting an unchanged recommendation.

## Measure the class before fixing an instance

Build the surface that measures a failure class before repairing the newest
example. In an epic, schedule that surface first. A proposed fix cites the
measurement command's current output, and a landed fix reports what the same
surface shows afterwards.

A worker has no network; repeat its timings that cross one from the main
checkout.

A fix without class-level measurement is instance patching. The monitor ranks
above a patch because it reveals prevalence, cost and unseen paths.
