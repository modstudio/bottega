## Purpose

Provide the local model service consumed through an OpenAI-compatible endpoint.

## Belongs here

Model-host deployment, service configuration, and endpoint smoke checks belong here.

## Does not belong here

Host-specific facts belong in machine-scope docs, tunnel installation belongs in `ops/`,
agent definitions belong in `orchestrator/`, and shared code belongs in `shared/`.

## May depend on

Local-stack code may depend on `local-stack/` and `shared/` only.
`scripts/check-architecture.ts` enforces concern isolation.
