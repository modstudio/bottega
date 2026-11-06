import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { migrationSessionStatements } from './migration-session.ts'
import {
  RECORD_CHANGE_CHILD_TABLES,
  RECORD_CHANGE_EXCLUDED_TABLES,
  RECORD_CHANGE_TRIGGER_TABLES,
} from './schema-record-change.ts'

const migrationsFolder = join(fileURLToPath(new URL('.', import.meta.url)), 'migrations')
let database: PGlite

async function applyMigration(transaction: Transaction, migration: MigrationMeta) {
  for (const statement of migration.sql) await transaction.exec(statement)
  await transaction.query(
    'INSERT INTO drizzle.__drizzle_migrations (hash,created_at,name) VALUES ($1,$2,$3)',
    [migration.hash, migration.folderMillis, migration.name],
  )
}

beforeAll(async () => {
  database = new PGlite()
  await database.exec(`
    CREATE ROLE record_owner LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE record_actor LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE record_auth LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE record_public NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE record_reader LOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT record_public TO record_actor WITH INHERIT FALSE, SET TRUE;
    GRANT CREATE ON DATABASE postgres TO record_owner;
    ALTER SCHEMA public OWNER TO record_owner;
    SET ROLE record_owner;
    CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY, hash text NOT NULL, created_at bigint, name text
    );
  `)
  await database.transaction(async (transaction) => {
    for (const statement of migrationSessionStatements()) await transaction.exec(statement)
    for (const migration of readMigrationFiles({ migrationsFolder }))
      await applyMigration(transaction, migration)
  })
})

afterAll(async () => database.close())

test('every replicated hub table is logged or explicitly excluded', async () => {
  const candidates = (
    await database.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables candidate
      WHERE table_schema='public' AND table_type='BASE TABLE'
        AND table_name LIKE 'hub\\_%' ESCAPE '\\'
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema=candidate.table_schema
            AND table_name=candidate.table_name AND column_name='space_id'
        )
      ORDER BY table_name
    `)
  ).rows.map(({ table_name }) => table_name)
  const classified = new Set<string>([
    ...RECORD_CHANGE_TRIGGER_TABLES,
    ...Object.keys(RECORD_CHANGE_EXCLUDED_TABLES),
  ])
  expect(candidates.filter((table) => !classified.has(table))).toEqual([])
})

test('record change trigger set equals its declaration', async () => {
  const triggers = (
    await database.query<{ table_name: string; enabled: string; trigger_type: number }>(`
      SELECT c.relname table_name,t.tgenabled enabled,t.tgtype::int trigger_type
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE NOT t.tgisinternal AND p.proname='record_change_log_row'
      ORDER BY c.relname
    `)
  ).rows
  expect(triggers.map(({ table_name }) => table_name)).toEqual(
    [...RECORD_CHANGE_TRIGGER_TABLES].toSorted(),
  )
  expect(
    triggers.every(({ enabled, trigger_type }) => enabled === 'O' && trigger_type === 29),
  ).toBe(true)
})

test('record change child triggers log their declared parent ids and tables', async () => {
  const triggers = (
    await database.query<{ table_name: string; trigger_arguments: string }>(`
      SELECT c.relname table_name,encode(t.tgargs,'escape') trigger_arguments
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE NOT t.tgisinternal AND p.proname='record_change_log_row' AND t.tgnargs > 1
      ORDER BY c.relname
    `)
  ).rows
  expect(
    triggers.map(({ table_name, trigger_arguments }) => [
      table_name,
      ...trigger_arguments.split('\\000').filter(Boolean),
    ]),
  ).toEqual(RECORD_CHANGE_CHILD_TABLES.map((entry) => [...entry]))
})

test('record change prune has no parameterised overload', async () => {
  expect(
    (
      await database.query<{ overload: string | null }>(
        "SELECT to_regprocedure('public.record_change_prune(interval)')::text AS overload",
      )
    ).rows,
  ).toEqual([{ overload: null }])
  await expect(database.query("SELECT record_change_prune(interval '30 days')")).rejects.toThrow()
})
