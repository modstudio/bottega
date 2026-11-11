import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { createNoDestinationWriteCounter } from '../record-no-destination-write-counter.ts'
import { migrationSessionStatements } from './migration-session.ts'
import { readNoDestinationWrites, recordNoDestinationWrite } from './no-destination-write-store.ts'
import { RECORD_ACTOR_ROLE } from './schema.ts'

const spaceA = '01990000-0000-7000-8000-000000009101'
const spaceB = '01990000-0000-7000-8000-000000009102'
const spaceC = '01990000-0000-7000-8000-000000009105'
const userId = '01990000-0000-7000-8000-000000009100'
const migrationsFolder = join(fileURLToPath(new URL('./migrations', import.meta.url)))

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
      ('${spaceB}','Telemetry B','telemetry-b',now()),
      ('${spaceC}','Telemetry C','telemetry-c',now());
    INSERT INTO "user" (id,email,name,created_at)
      VALUES ('${userId}','telemetry@example.test','Telemetry user',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at) VALUES
      ('01990000-0000-7000-8000-000000009103','${spaceA}','${userId}','member','write',now()),
      ('01990000-0000-7000-8000-000000009104','${spaceB}','${userId}','member','read',now());
    SET ROLE ${RECORD_ACTOR_ROLE};
  `)
  client = pgliteSql(database)
})

afterAll(async () => database.close())

test('report window does not claim coverage from before telemetry recording began', async () => {
  const bounds = (
    await database.query<{ coverageStart: Date; rawWindowStart: Date }>(`
      SELECT no_destination_write_coverage_start() AS "coverageStart",
        now() - interval '14 days' AS "rawWindowStart"
    `)
  ).rows[0]
  const report = await readNoDestinationWrites(
    client,
    { userId, spaceId: spaceA, spaceIds: [spaceA] },
    'api',
  )

  expect(bounds).toBeDefined()
  expect(new Date(report.windowStart).getTime()).toBeGreaterThanOrEqual(
    bounds!.coverageStart.getTime(),
  )
  expect(new Date(report.windowStart).getTime()).toBeGreaterThan(bounds!.rawWindowStart.getTime())
})

test('durable counts survive a counter restart and tenant reads exclude other spaces', async () => {
  const firstProcess = createNoDestinationWriteCounter()
  const decisionA = { spaceId: spaceA, route: '/v1/a', cause: 'cli/1' }
  await firstProcess.record(decisionA, () =>
    recordNoDestinationWrite(client, { userId, spaceId: spaceA }, decisionA, 'api'),
  )
  await recordNoDestinationWrite(
    client,
    { userId, spaceId: spaceB },
    { spaceId: spaceB, route: '/v1/b', cause: 'cli/2' },
    'api',
  )

  const restartedProcess = createNoDestinationWriteCounter()
  const report = await restartedProcess.read([spaceA], () =>
    readNoDestinationWrites(client, { userId, spaceId: spaceA, spaceIds: [spaceA] }, 'api'),
  )
  expect(report.counts).toEqual([{ ...decisionA, occurrences: 1, lastAt: expect.any(String) }])
  expect(report.counts).not.toContainEqual(expect.objectContaining({ spaceId: spaceB }))
})

test('read-only members are recorded while non-members are refused', async () => {
  const readOnlyDecision = { spaceId: spaceB, route: '/v1/read-only', cause: 'cli/3' }
  await expect(
    recordNoDestinationWrite(client, { userId, spaceId: spaceB }, readOnlyDecision, 'hub'),
  ).resolves.toBeUndefined()
  await recordNoDestinationWrite(client, { userId, spaceId: spaceB }, readOnlyDecision, 'hub')
  const otherCauseDecision = { ...readOnlyDecision, cause: 'cli/other' }
  await recordNoDestinationWrite(client, { userId, spaceId: spaceB }, otherCauseDecision, 'hub')
  const report = await readNoDestinationWrites(
    client,
    { userId, spaceId: spaceB, spaceIds: [spaceB] },
    'hub',
  )
  expect(report.counts).toEqual([
    expect.objectContaining({ ...readOnlyDecision, occurrences: 2 }),
    expect.objectContaining({ ...otherCauseDecision, occurrences: 1 }),
  ])

  await expect(
    recordNoDestinationWrite(
      client,
      { userId, spaceId: spaceC },
      { spaceId: spaceC, route: '/v1/non-member', cause: 'cli/4' },
      'hub',
    ),
  ).rejects.toThrow('destination-less write recording requires space membership')
})

test('prune removes only telemetry older than the raw window', async () => {
  await database.exec(`
    RESET ROLE;
    UPDATE no_destination_write SET at=now() - interval '15 days' WHERE space_id='${spaceA}';
    SET ROLE ${RECORD_ACTOR_ROLE};
  `)
  const result = (
    await database.query<{ deleted: number }>('SELECT no_destination_write_prune() AS deleted')
  ).rows[0]
  expect(Number(result?.deleted)).toBe(1)
  const remaining = await readNoDestinationWrites(
    client,
    { userId, spaceId: spaceB, spaceIds: [spaceB] },
    'api',
  )
  expect(remaining.counts).toEqual([
    expect.objectContaining({ spaceId: spaceB, route: '/v1/b', occurrences: 1 }),
  ])
})
