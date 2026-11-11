import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { migrationSessionStatements } from './record/migration-session.ts'
import { RECORD_ACTOR_ROLE } from './record/schema.ts'
import { createNoDestinationWriteCounter } from './record-no-destination-write-counter.ts'
import {
  readNoDestinationWrites,
  recordNoDestinationWrite,
} from './record-no-destination-write-store.ts'

const spaceA = '01990000-0000-7000-8000-000000009101'
const spaceB = '01990000-0000-7000-8000-000000009102'
const userId = '01990000-0000-7000-8000-000000009100'
const migrationsFolder = join(fileURLToPath(new URL('./record/migrations', import.meta.url)))

async function applyMigration(transaction: Transaction, migration: MigrationMeta) {
  for (const statement of migration.sql) await transaction.exec(statement)
  await transaction.query(
    'INSERT INTO drizzle.__drizzle_migrations (hash,created_at,name) VALUES ($1,$2,$3)',
    [migration.hash, migration.folderMillis, migration.name],
  )
}

function pgliteSql(database: PGlite): SQL {
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let statement = strings[0]!
    for (const [index] of values.entries()) statement += `$${index + 1}${strings[index + 1]!}`
    return (await database.query(statement, values)).rows
  }
  query.begin = (<T>(work: (tx: SQL) => Promise<T>) =>
    database.transaction((transaction) =>
      work(pgliteSql(transaction as unknown as PGlite)),
    )) as SQL['begin']
  return query as unknown as SQL
}

let database: PGlite
let client: SQL

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
  await database.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at) VALUES
      ('${spaceA}','Telemetry A','telemetry-a',now()),
      ('${spaceB}','Telemetry B','telemetry-b',now());
    INSERT INTO "user" (id,email,name,created_at)
      VALUES ('${userId}','telemetry@example.test','Telemetry user',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at) VALUES
      ('01990000-0000-7000-8000-000000009103','${spaceA}','${userId}','member','write',now()),
      ('01990000-0000-7000-8000-000000009104','${spaceB}','${userId}','member','write',now());
    SET ROLE ${RECORD_ACTOR_ROLE};
  `)
  client = pgliteSql(database)
})

afterAll(async () => database.close())

test('durable counts survive a counter restart and tenant reads exclude other spaces', async () => {
  const firstProcess = createNoDestinationWriteCounter()
  const decisionA = { spaceId: spaceA, route: '/v1/a', cause: 'cli/1' }
  await firstProcess.record(decisionA, () =>
    recordNoDestinationWrite(client, { userId, spaceId: spaceA }, decisionA),
  )
  await recordNoDestinationWrite(
    client,
    { userId, spaceId: spaceB },
    { spaceId: spaceB, route: '/v1/b', cause: 'cli/2' },
  )

  const restartedProcess = createNoDestinationWriteCounter()
  const report = await restartedProcess.read([spaceA], () =>
    readNoDestinationWrites(client, { userId, spaceId: spaceA, spaceIds: [spaceA] }),
  )
  expect(report.counts).toEqual([{ ...decisionA, occurrences: 1, lastAt: expect.any(String) }])
  expect(report.counts).not.toContainEqual(expect.objectContaining({ spaceId: spaceB }))
})

test('prune removes only telemetry older than the raw window', async () => {
  const moveDefinition = (
    await database.query<{ definition: string }>(
      "SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure) AS definition",
    )
  ).rows[0]?.definition
  expect(moveDefinition).toContain("('no_destination_write','space')")
  await database.exec(`
    RESET ROLE;
    UPDATE no_destination_write SET at=now() - interval '15 days' WHERE space_id='${spaceA}';
    SET ROLE ${RECORD_ACTOR_ROLE};
  `)
  const result = (
    await database.query<{ deleted: number }>('SELECT no_destination_write_prune() AS deleted')
  ).rows[0]
  expect(Number(result?.deleted)).toBe(1)
  const remaining = await readNoDestinationWrites(client, {
    userId,
    spaceId: spaceB,
    spaceIds: [spaceB],
  })
  expect(remaining.counts).toEqual([
    expect.objectContaining({ spaceId: spaceB, route: '/v1/b', occurrences: 1 }),
  ])
})
