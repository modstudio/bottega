import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { PLATFORM_NAME } from '../../shared/brand.ts'
import { RECORD_ACTOR_ROLE } from '../../shared/record/schema.ts'
import { HUB_CHANGE_SOURCES } from '../../shared/record/schema-hub.ts'
import {
  hubChangeReadability,
  READABLE_HUB_CHANGES,
  readHostedChangesInTransaction,
} from './hosted-changes.ts'

const migrationsFolder = join(
  fileURLToPath(new URL('../../shared/record/migrations', import.meta.url)),
)
const spaceA = '01990000-0000-7000-8000-000000001300'
const spaceB = '01990000-0000-7000-8000-000000001301'
const spaceC = '01990000-0000-7000-8000-000000001302'
const spaceD = '01990000-0000-7000-8000-000000001303'
const taskId = '01990000-0000-7000-8000-000000001310'
const movedId = '01990000-0000-7000-8000-000000001311'
const intervalId = '01990000-0000-7000-8000-000000001312'
const sendId = '01990000-0000-7000-8000-000000001313'
const recipientId = '01990000-0000-7000-8000-000000001314'
const noteId = '01990000-0000-7000-8000-000000001315'

async function applyMigration(transaction: Transaction, migration: MigrationMeta) {
  for (const statement of migration.sql) await transaction.exec(statement)
  await transaction.query(
    'INSERT INTO drizzle.__drizzle_migrations (hash,created_at,name) VALUES ($1,$2,$3)',
    [migration.hash, migration.folderMillis, migration.name],
  )
}

async function createDatabase() {
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
    for (const migration of readMigrationFiles({ migrationsFolder }))
      await applyMigration(transaction, migration)
  })
  await database.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at) VALUES
      ('${spaceA}','Changes A','changes-a',now()),
      ('${spaceB}','Changes B','changes-b',now()),
      ('${spaceC}','Changes C','changes-c',now()),
      ('${spaceD}','Changes D','changes-d',now());
  `)
  return database
}

type SqlFragment = { readonly sql: string }
function pgliteSql(database: PGlite): SQL {
  const query = async (strings: TemplateStringsArray, ...interpolations: unknown[]) => {
    let statement = strings[0]!
    const parameters: unknown[] = []
    for (const [index, interpolation] of interpolations.entries()) {
      if (typeof interpolation === 'object' && interpolation !== null && 'sql' in interpolation)
        statement += (interpolation as SqlFragment).sql
      else {
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

async function bind(database: PGlite, spaceId: string) {
  await database.exec(`
    RESET ROLE;
    SET ROLE ${RECORD_ACTOR_ROLE};
    SELECT set_config('app.user_id','change-reader',false);
    SELECT set_config('app.space_id','${spaceId}',false);
    SELECT set_config('app.space_ids','${spaceId}',false);
  `)
}

const identity = (spaceId: string) => ({ userId: 'change-reader', spaceId, spaceIds: [spaceId] })
const allReadable = Object.keys(READABLE_HUB_CHANGES) as (keyof typeof READABLE_HUB_CHANGES)[]
let database: PGlite

beforeAll(async () => {
  database = await createDatabase()
})
afterAll(async () => {
  if (database) await database.close()
})

test('every logged table is readable or explicitly deferred', () => {
  expect(HUB_CHANGE_SOURCES.rows.map((table) => [table, hubChangeReadability(table)])).toEqual([
    ['hub_task', 'readable'],
    ['hub_task_comment', 'readable'],
    ['hub_task_document', 'readable'],
    ['hub_task_status_event', 'readable'],
    ['hub_send', 'readable'],
    ['hub_interval', 'not-yet-readable'],
    ['hub_day', 'not-yet-readable'],
    ['hub_note', 'readable'],
    ['hub_note_acknowledgement', 'readable'],
  ])
  expect(hubChangeReadability('future_logged_table')).toBeNull()
})

test('change pages preserve trigger order, current pull shapes, collapse, deletes, and moves', async () => {
  const sql = pgliteSql(database)
  await bind(database, spaceA)
  await database.exec(`
    INSERT INTO hub_interval
      (id,space_id,source,start_at,end_at,ref,updated_at)
    VALUES ('${intervalId}','${spaceA}','test',now(),now(),'interval',now());
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at)
    VALUES ('${taskId}','${spaceA}','${PLATFORM_NAME}','DEV-1','${PLATFORM_NAME}','first','local',now(),now(),now(),now());
  `)
  const inserted = await readHostedChangesInTransaction(sql, identity(spaceA), {
    after: 0,
    limit: 500,
    tables: ['hub_task'],
  })
  expect(inserted.next).toBe(2)
  expect(inserted.changes).toHaveLength(1)
  expect(inserted.changes[0]).toMatchObject({
    sequence: 2,
    table: 'hub_task',
    id: taskId,
    op: 'upsert',
  })
  expect(inserted.changes[0]).toHaveProperty('row.title', 'first')

  await database.exec(`
    UPDATE hub_task SET title='second' WHERE id='${taskId}';
    UPDATE hub_task SET title='third' WHERE id='${taskId}';
  `)
  const supersededPage = await readHostedChangesInTransaction(sql, identity(spaceA), {
    after: 2,
    limit: 1,
    tables: ['hub_task'],
  })
  expect(supersededPage).toMatchObject({ next: 3, more: true, changes: [] })
  const collapsed = await readHostedChangesInTransaction(sql, identity(spaceA), {
    after: 2,
    limit: 500,
    tables: ['hub_task'],
  })
  expect(collapsed.changes).toHaveLength(1)
  expect(collapsed.changes[0]).toMatchObject({ sequence: 4, op: 'upsert', row: { title: 'third' } })

  await database.exec(`UPDATE hub_task SET deleted_at=now() WHERE id='${taskId}'`)
  const softDeleted = await readHostedChangesInTransaction(sql, identity(spaceA), {
    after: 4,
    limit: 500,
    tables: ['hub_task'],
  })
  expect(softDeleted.changes[0]).toMatchObject({ sequence: 5, op: 'upsert' })
  expect(
    (softDeleted.changes[0] as unknown as { row: { deleted_at: unknown } }).row.deleted_at,
  ).not.toBeNull()

  await database.exec(`DELETE FROM hub_task WHERE id='${taskId}'`)
  const hardDeleted = await readHostedChangesInTransaction(sql, identity(spaceA), {
    after: 5,
    limit: 500,
    tables: ['hub_task'],
  })
  expect(hardDeleted.changes).toEqual([
    { sequence: 6, table: 'hub_task', id: taskId, op: 'delete' },
  ])

  await bind(database, spaceA)
  await database.exec(`INSERT INTO hub_task
    (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at)
    VALUES ('${movedId}','${spaceA}','${PLATFORM_NAME}','DEV-2','${PLATFORM_NAME}','moved','local',now(),now(),now(),now())`)
  await database.exec(`RESET ROLE; SET ROLE record_owner;
    ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
    UPDATE hub_task SET space_id='${spaceB}' WHERE id='${movedId}';
    ALTER TABLE hub_task FORCE ROW LEVEL SECURITY`)
  await bind(database, spaceA)
  const movedOut = await readHostedChangesInTransaction(sql, identity(spaceA), {
    after: 6,
    limit: 500,
    tables: ['hub_task'],
  })
  expect(movedOut.changes.at(-1)).toEqual({
    sequence: 8,
    table: 'hub_task',
    id: movedId,
    op: 'delete',
  })
  await bind(database, spaceB)
  const movedIn = await readHostedChangesInTransaction(sql, identity(spaceB), {
    after: 0,
    limit: 500,
    tables: ['hub_task'],
  })
  expect(movedIn.changes).toHaveLength(1)
  expect(movedIn.changes[0]).toMatchObject({ sequence: 1, op: 'upsert', row: { title: 'moved' } })
})

test('paging, filters, resets, tenant isolation, and send recipient images follow the contract', async () => {
  const sql = pgliteSql(database)
  await bind(database, spaceC)
  await database.exec(`
    INSERT INTO hub_send
      (id,space_id,at,"window",recipients,projects,items,status,test,created_at,machine)
    VALUES ('${sendId}','${spaceC}',now(),'day','a@example.test','${PLATFORM_NAME}',1,'pending',0,now(),'test');
    INSERT INTO hub_send_recipient (id,space_id,send_id,name,email,created_at)
    VALUES ('${recipientId}','${spaceC}','${sendId}','A','a@example.test',now());
  `)
  const send = await readHostedChangesInTransaction(sql, identity(spaceC), {
    after: 0,
    limit: 500,
    tables: ['hub_send'],
  })
  expect(send.changes).toHaveLength(1)
  expect(send.changes[0]).toMatchObject({
    sequence: 2,
    row: { recipient_details: [{ name: 'A', email: 'a@example.test' }] },
  })

  await bind(database, spaceD)
  await database.exec(`
    INSERT INTO hub_note
      (id,space_id,project_name,number,project,text,anchors,sightings,created_at,last_seen_at,updated_at)
    VALUES ('${noteId}','${spaceD}','${PLATFORM_NAME}',1,'${PLATFORM_NAME}','note','[]',1,now(),now(),now());
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at)
    VALUES ('01990000-0000-7000-8000-000000001316','${spaceD}','${PLATFORM_NAME}','DEV-3','${PLATFORM_NAME}','task','local',now(),now(),now(),now());
  `)
  const first = await readHostedChangesInTransaction(sql, identity(spaceD), {
    after: 0,
    limit: 1,
    tables: ['hub_task'],
  })
  expect(first).toMatchObject({ next: 1, more: true, changes: [] })
  const second = await readHostedChangesInTransaction(sql, identity(spaceD), {
    after: first.next,
    limit: 1,
    tables: ['hub_task'],
  })
  expect(second).toMatchObject({ next: 2, more: false })
  expect(second.changes).toHaveLength(1)

  const beyond = await readHostedChangesInTransaction(sql, identity(spaceD), {
    after: 3,
    limit: 500,
    tables: allReadable,
  })
  expect(beyond).toMatchObject({ resetRequired: true, changes: [] })
  await database.exec(
    `RESET ROLE; SET ROLE record_owner; DELETE FROM hub_change WHERE space_id='${spaceD}' AND sequence=1`,
  )
  await bind(database, spaceD)
  const pruned = await readHostedChangesInTransaction(sql, identity(spaceD), {
    after: 0,
    limit: 500,
    tables: allReadable,
  })
  expect(pruned).toMatchObject({ oldest: 2, resetRequired: true, changes: [] })

  await database.exec(
    `RESET ROLE; SET ROLE record_owner; DELETE FROM hub_change WHERE space_id='${spaceD}'`,
  )
  await bind(database, spaceD)
  const fullyPruned = await readHostedChangesInTransaction(sql, identity(spaceD), {
    after: 0,
    limit: 500,
    tables: allReadable,
  })
  expect(fullyPruned).toMatchObject({ head: 2, oldest: null, resetRequired: true, changes: [] })
  const atHead = await readHostedChangesInTransaction(sql, identity(spaceD), {
    after: 2,
    limit: 500,
    tables: allReadable,
  })
  expect(atHead).toMatchObject({
    head: 2,
    oldest: null,
    next: 2,
    more: false,
    resetRequired: false,
    changes: [],
  })

  await bind(database, spaceA)
  const forbidden = await readHostedChangesInTransaction(sql, identity(spaceB), {
    after: 0,
    limit: 500,
    tables: ['hub_task'],
  })
  expect(forbidden).toMatchObject({ head: 0, oldest: null, changes: [] })
})
