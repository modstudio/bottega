import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { migrationSessionStatements } from '../../shared/record/migration-session.ts'
import { RECORD_ACTOR_ROLE } from '../../shared/record/schema.ts'
import { HOSTED_FIXTURE_MACHINE_ID } from '../test/hosted-record-fixture.ts'
import { hubChangeReadability } from './hosted-changes.ts'
import {
  applyDayChangeInTransaction,
  applyIntervalChangeInTransaction,
  type DayEvidence,
  hostedDayWrite,
  hostedIntervalWrite,
  type IntervalEvidence,
} from './hosted-evidence.ts'

const olderIntervalId = '01990000-0000-7000-8000-000000001000'
const newerIntervalId = '01990000-0000-7000-8000-000000001001'
const interval = {
  id: newerIntervalId,
  source: 'orch',
  ref: 'orch:1',
  start_at: '2026-10-08T00:00:00.000Z',
} as IntervalEvidence

const day = { id: 'client-id', day: '2026-10-08' } as DayEvidence

test('an unknown interval id with an existing tuple replaces it', () => {
  expect(hostedIntervalWrite(newerIntervalId, false, olderIntervalId)).toBe('replace')
})

test('an older interval id is superseded by the newer tuple holder', () => {
  expect(hostedIntervalWrite(olderIntervalId, false, newerIntervalId)).toBe('superseded')
})

test('an unknown day id with an existing date names both ids and the date', () => {
  expect(() => hostedDayWrite(day, null, 'hosted-id')).toThrow(
    'day identity conflict: date 2026-10-08 belongs to UUID hosted-id, not incoming UUID client-id',
  )
})

test('a known interval and day id update', () => {
  expect(hostedIntervalWrite(interval.id, true, interval.id)).toBe('update')
  expect(hostedDayWrite(day, day.id, day.id)).toBe('update')
})

test('a new interval tuple and day insert', () => {
  expect(hostedIntervalWrite(interval.id, false, null)).toBe('insert')
  expect(hostedDayWrite(day, null, null)).toBe('insert')
})

test('an existing newer interval replaces an older holder when it moves tuples', () => {
  expect(hostedIntervalWrite(newerIntervalId, true, olderIntervalId)).toBe('replace')
})

const migrationsFolder = join(
  fileURLToPath(new URL('../../shared/record/migrations', import.meta.url)),
)
const spaceId = '01990000-0000-7000-8000-000000001400'
const userId = '01990000-0000-7000-8000-000000001401'
const dayId = '01990000-0000-7000-8000-000000001402'
const intervalId = '01990000-0000-7000-8000-000000001403'
const projectId = '01990000-0000-7000-8000-000000001405'
const DAY_TOKENS = 8_338_668_790
const INTERVAL_TOKENS = 2_207_932_949

async function applyMigration(transaction: Transaction, migration: MigrationMeta) {
  for (const statement of migration.sql) await transaction.exec(statement)
  await transaction.query(
    'INSERT INTO drizzle.__drizzle_migrations (hash,created_at,name) VALUES ($1,$2,$3)',
    [migration.hash, migration.folderMillis, migration.name],
  )
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

async function hostedEvidenceDatabase() {
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
    for (const statement of migrationSessionStatements()) await transaction.exec(statement)
    for (const migration of readMigrationFiles({ migrationsFolder })) {
      await applyMigration(transaction, migration)
    }
  })
  await database.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${spaceId}','Token width','token-width',now());
    INSERT INTO project (id,space_id,name,created_at)
    VALUES ('${projectId}','${spaceId}','workshop',now());
    INSERT INTO "user" (id,email,name,created_at)
    VALUES ('${userId}','tokens@example.test','Token reader',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
    VALUES ('01990000-0000-7000-8000-000000001404','${spaceId}','${userId}','member','write',now());
    INSERT INTO machine (id,user_id,name,registered_at,last_seen)
    VALUES ('${HOSTED_FIXTURE_MACHINE_ID}','${userId}','fixture',now(),now());
    SET ROLE ${RECORD_ACTOR_ROLE};
    SELECT set_config('app.user_id','${userId}',false);
    SELECT set_config('app.space_id','${spaceId}',false);
    SELECT set_config('app.space_ids','${spaceId}',false);
  `)
  return database
}

test('hosted evidence accepts token totals above the 32-bit range', async () => {
  const database = await hostedEvidenceDatabase()
  const sql = pgliteSql(database)
  const identity = { userId, spaceId }
  const collectedAt = '2026-10-05T19:50:00.000Z'
  const startAt = '2026-10-05T10:00:00.000Z'
  const endAt = '2026-10-05T12:00:00.000Z'
  await applyIntervalChangeInTransaction(sql, identity, {
    id: intervalId,
    op: 'upsert',
    row: {
      id: intervalId,
      task_key: 'DEV-1240',
      project_name: 'workshop',
      projectId,
      source: 'claude',
      agent: null,
      job: null,
      start_at: startAt,
      end_at: endAt,
      claude_tokens: INTERVAL_TOKENS,
      vendor_tokens: INTERVAL_TOKENS,
      vendor_cost_usd: null,
      ref: 'transcript:dev-1240',
      via: null,
      open: 0,
      session_id: null,
      user_id: null,
    },
  })
  await applyDayChangeInTransaction(sql, identity, {
    id: dayId,
    machine_id: HOSTED_FIXTURE_MACHINE_ID,
    day: '2026-10-05',
    claude_tokens: DAY_TOKENS,
    cache_read: DAY_TOKENS,
    messages: 1,
    tasks: 1,
    canon_tokens: DAY_TOKENS,
    other_tokens: DAY_TOKENS,
    commits: 0,
    files: 0,
    lines_product: 0,
    lines_test: 0,
    lines_docs: 0,
    lines_config: 0,
    lines_generated: 0,
    collected_at: collectedAt,
  })

  const storedDay = (
    await database.query<{
      claude_tokens: string | number
      cache_read: string | number
      canon_tokens: string | number
      other_tokens: string | number
    }>(`SELECT claude_tokens,cache_read,canon_tokens,other_tokens FROM hub_day WHERE id=$1`, [
      dayId,
    ])
  ).rows[0]!
  const storedInterval = (
    await database.query<{ claude_tokens: string | number; vendor_tokens: string | number }>(
      `SELECT claude_tokens,vendor_tokens FROM hub_interval WHERE id=$1`,
      [intervalId],
    )
  ).rows[0]!

  expect(Number(storedDay.claude_tokens)).toBe(DAY_TOKENS)
  expect(Number(storedDay.cache_read)).toBe(DAY_TOKENS)
  expect(Number(storedDay.canon_tokens)).toBe(DAY_TOKENS)
  expect(Number(storedDay.other_tokens)).toBe(DAY_TOKENS)
  expect(Number(storedInterval.claude_tokens)).toBe(INTERVAL_TOKENS)
  expect(Number(storedInterval.vendor_tokens)).toBe(INTERVAL_TOKENS)

  expect(hubChangeReadability('hub_interval')).toBe('not-yet-readable')
  expect(hubChangeReadability('hub_day')).toBe('not-yet-readable')
  await database.close()
})

test('hosted interval nulls a task id absent from the caller space', async () => {
  const database = await hostedEvidenceDatabase()
  const absentTaskId = '01990000-0000-7000-8000-000000001499'
  try {
    expect(
      await applyIntervalChangeInTransaction(
        pgliteSql(database),
        { userId, spaceId },
        {
          id: intervalId,
          op: 'upsert',
          row: {
            id: intervalId,
            task_key: 'DEV-1764',
            task_id: absentTaskId,
            project_name: 'workshop',
            projectId,
            source: 'orch',
            agent: null,
            job: null,
            start_at: '2026-10-25T10:00:00.000Z',
            end_at: '2026-10-25T11:00:00.000Z',
            claude_tokens: 1,
            vendor_tokens: 1,
            vendor_cost_usd: null,
            ref: 'run:dev-1764',
            via: null,
            open: 0,
            session_id: null,
            user_id: null,
          },
        },
      ),
    ).toEqual({ status: 'applied' })
    expect(
      (
        await database.query<{ task_id: string | null }>(
          `SELECT task_id::text FROM hub_interval WHERE id=$1`,
          [intervalId],
        )
      ).rows[0],
    ).toEqual({ task_id: null })
  } finally {
    await database.close()
  }
})
