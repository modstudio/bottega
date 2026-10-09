#!/usr/bin/env bun
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { managedCanonProjectNames } from '../orchestrator/src/record/record-canon-facts.ts'
import {
  PLATFORM_SPACE_ID,
  RECORD_ACTOR_ROLE,
  RECORD_AUTH_ROLE,
  RECORD_OWNER_ROLE,
  RECORD_PUBLIC_ROLE,
  RECORD_READER_ROLE,
} from '../shared/record/schema.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const migrationsFolder = join(root, 'shared', 'record', 'migrations')
const rerun = 'bun scripts/check-record-migrations-apply.ts'
const brokenDocBackfill = '20260924180716_dev_906_doc_latest_revision'
const repairedDocBackfill = '20260924201224_dev_917_doc_latest_revision_repair'
const audienceBackfill = '20261009160001_dev_1238_doc_audiences_backfill'
const proofDocId = '01990000-0000-7000-8000-000000000010'
const proofRevisionId = '01990000-0000-7000-8000-000000000012'
const managedProjectId = '01990000-0000-7000-8000-000000000013'
const unmanagedProjectId = '01990000-0000-7000-8000-000000000014'

class CheckFailure extends Error {}

function firstLine(sql: string): string {
  return (
    sql
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? '<empty chunk>'
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function phaseFailure(phase: string, error: unknown): CheckFailure {
  return new CheckFailure(
    `${phase} failed: ${errorMessage(error)}. Check that @electric-sql/pglite is installed (bun install) and the migrations folder is readable, then rerun ${rerun}.`,
  )
}

function migrationFailure(
  migration: MigrationMeta,
  statement: string,
  error: unknown,
): CheckFailure {
  return new CheckFailure(
    `shared/record/migrations/${migration.name}/migration.sql failed at ${JSON.stringify(firstLine(statement))}: ${errorMessage(error)}. Fix that migration (never edit a generated one; regenerate it or add a custom one per .agents/contexts/orchestrator-record.md), then rerun ${rerun}.`,
  )
}

async function provision(database: PGlite): Promise<void> {
  await database.exec(`
    CREATE ROLE ${RECORD_OWNER_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE ${RECORD_ACTOR_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE ${RECORD_AUTH_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE ${RECORD_PUBLIC_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE ${RECORD_READER_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT ${RECORD_PUBLIC_ROLE} TO ${RECORD_ACTOR_ROLE} WITH INHERIT FALSE, SET TRUE;
    GRANT CREATE ON DATABASE postgres TO ${RECORD_OWNER_ROLE};
    ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};
    SET ROLE ${RECORD_OWNER_ROLE};
    CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint,
      name text,
      applied_at timestamp with time zone DEFAULT now()
    );
  `)
}

async function applyMigration(transaction: Transaction, migration: MigrationMeta): Promise<void> {
  for (const chunk of migration.sql) {
    try {
      await transaction.exec(chunk)
    } catch (error) {
      throw migrationFailure(migration, chunk, error)
    }
  }
  const journalInsert =
    'INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name) VALUES ($1, $2, $3)'
  try {
    await transaction.query(journalInsert, [migration.hash, migration.folderMillis, migration.name])
  } catch (error) {
    throw migrationFailure(migration, journalInsert, error)
  }
}

async function seedDocBackfillProof(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    SELECT set_config('app.space_id', '01990000-0000-7000-8000-000000000001', true);
    INSERT INTO doc (id, space_id, scope, subject, slug, title, body, delivery, created_at, updated_at)
    VALUES (
      '${proofDocId}', '01990000-0000-7000-8000-000000000001', 'global', NULL,
      'migration-proof', 'Migration proof', 'body', 'demand',
      '2026-09-24T19:00:00Z', '2026-09-24T19:00:00Z'
    );
    INSERT INTO doc_revision (
      id, space_id, doc_id, scope, subject, slug, op, title, body, delivery,
      author, reason, at
    ) VALUES
      (
        '01990000-0000-7000-8000-000000000011',
        '01990000-0000-7000-8000-000000000001', '${proofDocId}', 'global', NULL,
        'migration-proof', 'create', 'Migration proof', 'body', 'demand',
        'migration-check', 'prove latest revision backfill', '2026-09-24T19:00:00Z'
      ),
      (
        '${proofRevisionId}', '01990000-0000-7000-8000-000000000001',
        '${proofDocId}', 'global', NULL, 'migration-proof', 'set', 'Migration proof',
        'new body', 'demand', 'migration-check', 'prove latest revision backfill',
        '2026-09-24T19:00:00Z'
      );
    SELECT set_config('app.space_id', '', true);
  `)
}

async function proofLatestRevision(transaction: Transaction): Promise<string | null> {
  await transaction.exec(
    `SELECT set_config('app.space_id', '01990000-0000-7000-8000-000000000001', true);`,
  )
  const result = await transaction.query<{ latest_revision_id: string | null }>(
    'SELECT latest_revision_id FROM doc WHERE id = $1',
    [proofDocId],
  )
  await transaction.exec(`SELECT set_config('app.space_id', '', true);`)
  if (result.rows.length !== 1) throw new CheckFailure('doc backfill proof row is not visible')
  return result.rows[0]?.latest_revision_id ?? null
}

async function proofAudienceBackfill(transaction: Transaction): Promise<void> {
  const docs = await transaction.query<{ invalid: number }>(
    'SELECT count(*)::int AS invalid FROM doc WHERE audiences IS DISTINCT FROM ARRAY[audience]',
  )
  const revisions = await transaction.query<{ invalid: number }>(
    'SELECT count(*)::int AS invalid FROM doc_revision WHERE audiences IS DISTINCT FROM ARRAY[audience]',
  )
  if (docs.rows[0]?.invalid !== 0 || revisions.rows[0]?.invalid !== 0) {
    throw new CheckFailure('DEV-1238 audience backfill did not produce singleton sets')
  }
}

function sqlTag(transaction: Transaction): SQL {
  return (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const statement = parts.reduce(
      (sql, part, index) => `${sql}${index === 0 ? '' : `$${index}`}${part}`,
      '',
    )
    return (await transaction.query(statement, values)).rows
  }) as unknown as SQL
}

async function proofManagedCanonProjects(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    SELECT set_config('app.space_id', '${PLATFORM_SPACE_ID}', true);
    INSERT INTO project (id, space_id, name, managed_context, created_at) VALUES
      ('${managedProjectId}', '${PLATFORM_SPACE_ID}', 'managed-proof', true, now()),
      ('${unmanagedProjectId}', '${PLATFORM_SPACE_ID}', 'unmanaged-proof', false, now());
  `)
  const names = await managedCanonProjectNames(sqlTag(transaction), PLATFORM_SPACE_ID)
  if (names.length !== 1 || names[0] !== 'managed-proof') {
    throw new CheckFailure(
      `user-canon managed project selection returned ${JSON.stringify(names)} instead of ["managed-proof"]`,
    )
  }
}

async function main(): Promise<void> {
  let database: PGlite | undefined
  let failure: unknown
  let applied = 0
  try {
    let migrations: MigrationMeta[]
    try {
      migrations = readMigrationFiles({ migrationsFolder })
    } catch (error) {
      throw phaseFailure('reading migrations', error)
    }
    try {
      database = new PGlite()
      await database.waitReady
    } catch (error) {
      throw phaseFailure('starting PGlite', error)
    }
    try {
      await provision(database)
    } catch (error) {
      throw phaseFailure('provisioning PGlite', error)
    }
    try {
      await database.transaction(async (transaction) => {
        for (const migration of migrations) {
          if (migration.name === brokenDocBackfill) await seedDocBackfillProof(transaction)
          await applyMigration(transaction, migration)
          if (
            migration.name === brokenDocBackfill &&
            (await proofLatestRevision(transaction)) !== null
          ) {
            throw new CheckFailure('DEV-906 doc backfill unexpectedly populated the proof row')
          }
          if (
            migration.name === repairedDocBackfill &&
            (await proofLatestRevision(transaction)) !== proofRevisionId
          ) {
            throw new CheckFailure('DEV-917 doc backfill did not select the newest proof revision')
          }
          if (migration.name === audienceBackfill) await proofAudienceBackfill(transaction)
        }
        await proofManagedCanonProjects(transaction)
      })
    } catch (error) {
      throw error instanceof CheckFailure ? error : phaseFailure('replaying migrations', error)
    }
    applied = migrations.length
  } catch (error) {
    failure = error
  } finally {
    if (database) {
      try {
        await database.close()
      } catch (error) {
        failure ??= phaseFailure('closing PGlite', error)
      }
    }
  }
  if (failure) throw failure
  console.log(`record migrations apply: ${applied} applied`)
}

try {
  await main()
} catch (error) {
  console.error(errorMessage(error))
  process.exitCode = 1
}
