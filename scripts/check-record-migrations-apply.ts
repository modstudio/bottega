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
      name text
    );
  `)
}

async function applyMigration(transaction: Transaction, migration: MigrationMeta): Promise<void> {
  for (const chunk of migration.sql) {
    try {
      await transaction.exec(chunk)
    } catch (error) {
      throw new Error(
        `migration ${migration.name} failed at ${JSON.stringify(firstLine(chunk))}: ${errorMessage(error)}`,
      )
    }
  }
  await transaction.query(
    'INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name) VALUES ($1, $2, $3)',
    [migration.hash, migration.folderMillis, migration.name],
  )
}

async function main(): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder })
  const database = new PGlite()
  try {
    await database.waitReady
    await provision(database)
    for (const migration of migrations) {
      await database.transaction((transaction) => applyMigration(transaction, migration))
    }
    console.log(`record migrations apply: ${migrations.length} applied`)
  } finally {
    await database.close()
  }
}

try {
  await main()
} catch (error) {
  console.error(errorMessage(error))
  process.exitCode = 1
}
