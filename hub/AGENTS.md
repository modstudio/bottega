## Purpose

Present work in flight, task cost, tasks, documents, and reports across projects.

## Belongs here

The hub database and migrations, collection and attribution, task and document services,
reporting, the tRPC API, and the dashboard belong here.

## Does not belong here

Run orchestration belongs in `orchestrator/`, machine upkeep belongs in `ops/`, local
model serving belongs in `local-stack/`, and code shared by concerns belongs in `shared/`.

## May depend on

Hub code may depend on `hub/` and `shared/` only. Dashboard code may import only dashboard
code plus the hub router type. `scripts/check-architecture.ts` enforces these import rules.
