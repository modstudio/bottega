## Purpose

Maintain this machine through unattended jobs and their installation assets.

## Belongs here

Launchd templates, machine-refresh scripts, upkeep installers, and operational shell
automation belong here.

## Does not belong here

Orchestration belongs in `orchestrator/`, reporting belongs in `hub/`, local model service
assets belong in `local-stack/`, and reusable application code belongs in `shared/`.

## May depend on

Ops code may depend on `ops/` and `shared/` only. `scripts/check-architecture.ts` enforces
concern isolation.
