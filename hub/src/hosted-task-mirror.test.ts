import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { RECORD_ACTOR_ROLE } from '../../shared/record/schema.ts'
import { type HostedTask, mirrorHostedTaskBody } from './hosted-tasks.ts'

const migrationsFolder = join(
  fileURLToPath(new URL('../../shared/record/migrations', import.meta.url)),
)
const spaceId = '01990000-0000-7000-8000-000000001250'
const firstId = '01990000-0000-7000-8000-000000001251'
const secondId = '01990000-0000-7000-8000-000000001252'
const userId = '01990000-0000-7000-8000-000000001249'
const identity = { userId, spaceId }

async function applyMigration(transaction: Transaction, migration: MigrationMeta) {
  for (const statement of migration.sql) await transaction.exec(statement)
  await transaction.query(
    'INSERT INTO drizzle.__drizzle_migrations (hash,created_at,name) VALUES ($1,$2,$3)',
    [migration.hash, migration.folderMillis, migration.name],
  )
}

async function createRecordDatabase(): Promise<PGlite> {
  const database = new PGlite()
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
    for (const migration of readMigrationFiles({ migrationsFolder })) {
      await applyMigration(transaction, migration)
    }
  })
  await database.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${spaceId}','Mirror test','mirror-test',now());
    INSERT INTO "user" (id,email,name,created_at)
    VALUES ('${userId}','mirror@example.test','Mirror user',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('01990000-0000-7000-8000-000000001248','${spaceId}','${userId}','member','write',now());
    SET ROLE ${RECORD_ACTOR_ROLE};
    SELECT set_config('app.user_id','${userId}',false);
    SELECT set_config('app.space_id','${spaceId}',false);
    SELECT set_config('app.space_ids','${spaceId}',false);
  `)
  return database
}

type SqlFragment = { readonly sql: string }

function pgliteSql(database: PGlite): SQL {
  const query = async (strings: TemplateStringsArray, ...interpolations: unknown[]) => {
    let statement = strings[0]!
    const parameters: unknown[] = []
    for (const [index, interpolation] of interpolations.entries()) {
      if (typeof interpolation === 'object' && interpolation !== null && 'sql' in interpolation) {
        statement += (interpolation as SqlFragment).sql
      } else {
        parameters.push(interpolation)
        statement += `$${parameters.length}`
      }
      statement += strings[index + 1]!
    }
    return (await database.query(statement, parameters)).rows
  }
  query.unsafe = (sql: string) => ({ sql })
  return query as unknown as SQL
}

const task = (id: string, key: string, title: string, at: string): HostedTask => ({
  id,
  key,
  project: 'workshop',
  project_name: 'workshop',
  title,
  status: 'active',
  status_category: 'active',
  parent_key: null,
  body: null,
  assignee: null,
  opened_at: '2026-10-09T10:00:00.000Z',
  closed_at: null,
  source: 'mcp',
  first_seen: '2026-10-09T10:00:00.000Z',
  last_seen: at,
  created_at: '2026-10-09T10:00:00.000Z',
  updated_at: at,
  deleted_at: null,
  next_document_number: 1,
})

let database: PGlite

beforeAll(async () => {
  database = await createRecordDatabase()
})

afterAll(async () => {
  if (database) await database.close()
})

test('task mirroring writes only changed or missing hosted rows', async () => {
  const sql = pgliteSql(database)
  const firstAt = '2026-10-09T11:00:00.000Z'
  const changedAt = '2026-10-09T12:00:00.000Z'
  const first = task(firstId, 'DEV-1', 'First', firstAt)
  const second = task(secondId, 'DEV-2', 'Second', firstAt)

  await mirrorHostedTaskBody(sql, identity, { tasks: [first, second] }, 2)
  const afterFirst = await database.query<{ id: string; updated_at: string }>(
    `SELECT id::text,updated_at::text FROM hub_task ORDER BY id`,
  )
  expect(
    (
      await database.query<{ count: number }>(
        `SELECT count(*)::int count FROM hub_change WHERE table_name='hub_task'`,
      )
    ).rows[0]?.count,
  ).toBe(2)

  await mirrorHostedTaskBody(
    sql,
    identity,
    {
      tasks: [
        { ...first, first_seen: changedAt, last_seen: changedAt },
        { ...second, first_seen: changedAt, last_seen: changedAt },
      ],
    },
    2,
  )
  expect(
    (
      await database.query<{ count: number }>(
        `SELECT count(*)::int count FROM hub_change WHERE table_name='hub_task'`,
      )
    ).rows[0]?.count,
  ).toBe(2)
  expect(
    (await database.query(`SELECT id::text,updated_at::text FROM hub_task ORDER BY id`)).rows,
  ).toEqual(afterFirst.rows)

  await mirrorHostedTaskBody(
    sql,
    identity,
    { tasks: [{ ...first, title: 'Changed first', updated_at: changedAt, last_seen: changedAt }] },
    1,
  )
  expect(
    (
      await database.query<{ count: number }>(
        `SELECT count(*)::int count FROM hub_change WHERE table_name='hub_task'`,
      )
    ).rows[0]?.count,
  ).toBe(3)
  expect(
    (
      await database.query<{ id: string; updated_at: string; first_seen: string }>(
        `SELECT id::text,updated_at::text,first_seen::text FROM hub_task ORDER BY id`,
      )
    ).rows,
  ).toEqual([
    { id: firstId, updated_at: '2026-10-09 12:00:00+00', first_seen: '2026-10-09 10:00:00+00' },
    { id: secondId, updated_at: '2026-10-09 11:00:00+00', first_seen: '2026-10-09 10:00:00+00' },
  ])

  await database.query(`DELETE FROM hub_task WHERE id=$1`, [secondId])
  const beforeHealing = (
    await database.query<{ count: number }>(
      `SELECT count(*)::int count FROM hub_change WHERE table_name='hub_task'`,
    )
  ).rows[0]!.count
  await mirrorHostedTaskBody(sql, identity, { tasks: [second] }, 1)
  expect(
    (
      await database.query<{ count: number }>(
        `SELECT count(*)::int count FROM hub_change WHERE table_name='hub_task'`,
      )
    ).rows[0]?.count,
  ).toBe(beforeHealing + 1)
  expect((await database.query(`SELECT title FROM hub_task WHERE id=$1`, [secondId])).rows).toEqual(
    [{ title: 'Second' }],
  )
})
