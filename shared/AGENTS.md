## Purpose

Hold code that more than one concern imports.

## Belongs here

Small, concern-neutral types and capabilities with multiple consumers belong here.

## Does not belong here

Concern-specific policy and adapters belong in `orchestrator/`, `hub/`, `ops/`, or
`local-stack/` according to ownership.

## May depend on

Shared code may depend on `shared/` only and must not reach into a concern.
`scripts/check-architecture.ts` enforces this import rule.
