---
description: The hosted record's Postgres schema, roles, identity, API surface and grants.
paths:
  - shared/record/**
  - shared/record-session.ts
  - orchestrator/src/record/**
  - orchestrator/deploy/api/**
---

# The hosted record

- Postgres is schema-first: edit `shared/record/schema.ts`, generate with `shared/record/drizzle.config.ts`, and commit the folder and snapshot; never edit generated `migration.sql`. Kit-inexpressible SQL (`FORCE ROW LEVEL SECURITY`, grants, seeds) goes in a custom migration. The migration role holds `CREATE` on the `drizzle` metadata schema; tenant roles have none. The gate proves snapshot-chain consistency and no ungenerated change, and `scripts/check-record-migrations-apply.ts` applies every migration in one transaction to an in-process Postgres as `record_owner`. A change to the record migrations lands only after `scripts/record-rehearse.ts` has rehearsed it on a restore of the newest backup; the `record-rehearsal` CI job enforces this.
- Every pending migration runs in one transaction, so one blocked statement holds the whole batch. `migrationSessionSettings` in `orchestrator/src/postgres/postgres-migrate.ts` therefore bounds lock waits, statements, idle transactions and dead-client detection on the migration session. A migration that needs longer may raise a bound with `SET LOCAL`, but must never disable one; `scripts/record-migration-bounds.ts` refuses it at the gate.
- Record roles are `record_owner` for migrations, `record_actor` for the application, and `record_reader` for reporting. The actor may select, insert and update `machine` and `user`, never delete them; the reader selects both.
- `BOTTEGA_RECORD_MIGRATE_URL` carries the owner connection and `BOTTEGA_RECORD_URL` the actor connection; the database creator must first run `ALTER SCHEMA public OWNER TO record_owner`.
- Better Auth owns identity: a space is an organization and every user has a self-healing personal space. The CLI bearer is in the keychain (`shared/record-session.ts`); sync uses its user and active space. Required columns follow expand, backfill, contract.
- The hosted record API is a surface over record services: it resolves a Better Auth session for every request, and each tenant query sets `app.user_id` and `app.space_id` inside its transaction. The CLI still reaches the record directly. Deployment configuration lives in `orchestrator/deploy/api`; secrets live only in the Fly app.
- Grants live in the custom `record_grants` migration, whose `ALTER DEFAULT PRIVILEGES` rules make later tables inherit actor and reader access.
