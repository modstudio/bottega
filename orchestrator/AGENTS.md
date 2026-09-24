# Orchestrator

## Purpose

Route work to external agents, record what each run cost and how good it was, and use that history to choose who gets the next job of that kind. Design, judgment and synthesis stay with the architect; the agent types.

## Belongs here

Run lifecycle, disposable worktrees, the worker contract and escalation, routing and scoring, review lenses, the project register, operator docs, the canon store and hydrator, the MCP surface, and the hooks that bind those to a harness.

## Does not belong here

The dashboard and cost-ratio presentation (`hub/`). Machine upkeep (`ops/`). Local-model host facts (`orch doc show local-model-host-incidents --scope machine`). Product-domain work of other projects.

## May depend on

`shared/` only. `scripts/check-architecture.ts` enforces that orchestrator never imports another concern.
