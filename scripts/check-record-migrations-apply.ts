#!/usr/bin/env bun
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import {
  RECORD_ACTOR_ROLE,
  RECORD_AUTH_ROLE,
  RECORD_OWNER_ROLE,
  RECORD_READER_ROLE,
} from '../shared/record/schema.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const migrationsFolder = join(root, 'shared', 'record', 'migrations')
const rerun = 'bun scripts/check-record-migrations-apply.ts'

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
    CREATE ROLE ${RECORD_READER_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS;
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
        for (const migration of migrations) await applyMigration(transaction, migration)
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
