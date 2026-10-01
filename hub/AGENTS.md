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

## External MCP dialect evidence

Before replacing the outbound Streamable HTTP client in `src/mcp.ts`, run
`bun run --cwd hub evidence:mcp-dialects`. This is the required live compatibility evidence:
it calls one read-only tracker tool through each registered external implementation, prints
sanitized protocol and transport facts, and writes the same report to the hub state directory.
It is an operator command, not a gate test, because it reaches real services with credentials
resolved at use time.
