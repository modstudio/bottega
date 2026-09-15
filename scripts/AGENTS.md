## Purpose

Enforce repository-wide quality and architecture rules.

## Belongs here

Root gate orchestration, static checks, quality baselines, and check infrastructure belong
here.

## Does not belong here

Runtime product behavior belongs in its owning concern, and reusable runtime code belongs
in `shared/`.

## May depend on

Scripts may inspect every concern and may import repository check infrastructure.
`scripts/check-architecture.ts` enforces the concern import rules that these checks protect.
