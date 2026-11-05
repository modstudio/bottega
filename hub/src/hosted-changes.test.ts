import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { PLATFORM_NAME } from '../../shared/brand.ts'
import { migrationSessionStatements } from '../../shared/record/migration-session.ts'
import { readRecordChanges } from '../../shared/record/record-changes.ts'
import { RECORD_ACTOR_ROLE } from '../../shared/record/schema.ts'
import { HUB_CHANGE_SOURCES } from '../../shared/record/schema-hub.ts'
import { RECORD_CHANGE_LOGGED_TABLES } from '../../shared/record/schema-record-change.ts'
import { bindTenant } from '../../shared/record/tenant.ts'
import {
  hubChangeReadability,
  laterRowKeys,
  READABLE_HUB_CHANGES,
  readHostedChangesInTransaction,
} from './hosted-changes.ts'
import { materializeHostedRecordChangePage } from './hosted-record-changes.ts'

const migrationsFolder = join(
  fileURLToPath(new URL('../../shared/record/migrations', import.meta.url)),
)
const spaceA = '01990000-0000-7000-8000-000000001300'
const spaceB = '01990000-0000-7000-8000-000000001301'
const spaceC = '01990000-0000-7000-8000-000000001302'
const spaceD = '01990000-0000-7000-8000-000000001303'
const spaceE = '01990000-0000-7000-8000-000000001304'
const spaceF = '01990000-0000-7000-8000-000000001305'
const spaceG = '01990000-0000-7000-8000-000000001306'
const spaceH = '01990000-0000-7000-8000-000000001307'
const taskId = '01990000-0000-7000-8000-000000001310'
const lastDeleteId = '01990000-0000-7000-8000-000000001317'
const recreatedId = '01990000-0000-7000-8000-000000001318'
const movedId = '01990000-0000-7000-8000-000000001311'
const intervalId = '01990000-0000-7000-8000-000000001312'
const sendId = '01990000-0000-7000-8000-000000001313'
const recipientId = '01990000-0000-7000-8000-000000001314'
const noteId = '01990000-0000-7000-8000-000000001315'
const userId = '01990000-0000-7000-8000-000000001299'

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
    for (const statement of migrationSessionStatements()) await transaction.exec(statement)
    for (const migration of readMigrationFiles({ migrationsFolder }))
      await applyMigration(transaction, migration)
  })
  await database.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at) VALUES
      ('${spaceA}','Changes A','changes-a',now()),
      ('${spaceB}','Changes B','changes-b',now()),
      ('${spaceC}','Changes C','changes-c',now()),
      ('${spaceD}','Changes D','changes-d',now()),
      ('${spaceE}','Changes E','changes-e',now()),
      ('${spaceF}','Changes F','changes-f',now()),
      ('${spaceG}','Changes G','changes-g',now()),
      ('${spaceH}','Changes H','changes-h',now());
    INSERT INTO "user" (id,email,name,created_at)
    VALUES ('${userId}','changes@example.test','Change reader',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at) VALUES
      ('01990000-0000-7000-8000-000000001290','${spaceA}','${userId}','member','write',now()),
      ('01990000-0000-7000-8000-000000001291','${spaceB}','${userId}','member','write',now()),
      ('01990000-0000-7000-8000-000000001292','${spaceC}','${userId}','member','write',now()),
      ('01990000-0000-7000-8000-000000001293','${spaceD}','${userId}','member','write',now()),
      ('01990000-0000-7000-8000-000000001294','${spaceE}','${userId}','member','write',now()),
      ('01990000-0000-7000-8000-000000001295','${spaceF}','${userId}','member','write',now()),
      ('01990000-0000-7000-8000-000000001296','${spaceG}','${userId}','member','write',now()),
      ('01990000-0000-7000-8000-000000001297','${spaceH}','${userId}','member','write',now());
  `)
  return database
}

type SqlFragment = { readonly sql: string }
function pgliteSql(database: Pick<PGlite, 'query'>): SQL {
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

function pgliteClient(database: PGlite): SQL {
  const client = pgliteSql(database)
  client.begin = ((work: (tx: SQL) => Promise<unknown>) =>
    database.transaction((transaction) => work(pgliteSql(transaction)))) as SQL['begin']
  return client
}

async function bind(database: PGlite, spaceId: string) {
  await database.exec(`
    RESET ROLE;
    SET ROLE ${RECORD_ACTOR_ROLE};
    SELECT set_config('app.user_id','${userId}',false);
    SELECT set_config('app.space_id','${spaceId}',false);
    SELECT set_config('app.space_ids','${spaceId}',false);
  `)
}

const identity = (spaceId: string) => ({ userId, spaceId, spaceIds: [spaceId] })
const allReadable = Object.keys(READABLE_HUB_CHANGES) as (keyof typeof READABLE_HUB_CHANGES)[]
let database: PGlite

beforeAll(async () => {
  database = await createDatabase()
})
afterAll(async () => {
  if (database) await database.close()
})

test('a first read resets to the horizon, then reads committed tenant changes after it', async () => {
  await database.exec(`INSERT INTO project(id,space_id,name,key_prefixes,created_at)
    VALUES ('01990000-0000-7000-8000-000000001319','${spaceA}','record-feed',ARRAY['RCF'],now())`)
  const identity = { userId, spaceId: spaceA }
  const first = await readRecordChanges(
    pgliteClient(database),
    identity,
    null,
    1,
    RECORD_CHANGE_LOGGED_TABLES,
  )
  expect(first.resetRequired).toBe(true)
  const page = await readRecordChanges(
    pgliteClient(database),
    identity,
    first.cursor,
    1,
    RECORD_CHANGE_LOGGED_TABLES,
  )
  expect(page.resetRequired).toBe(false)
  if (!page.resetRequired) {
    expect(page.changes).toHaveLength(1)
    expect(page.cursor).toEqual({ xid: page.changes[0]!.xid, seq: page.changes[0]!.seq })
  }
})

test('record change pages follow numeric order across a digit boundary', async () => {
  await database.exec(`SELECT setval('record_change_seq_seq', 998);
    BEGIN;
    INSERT INTO project(id,space_id,name,key_prefixes,created_at) VALUES
      ('01990000-0000-7000-8000-000000001320','${spaceA}','record-digit-a',ARRAY['RDA'],now()),
      ('01990000-0000-7000-8000-000000001321','${spaceA}','record-digit-b',ARRAY['RDB'],now());
    COMMIT;`)
  const identity = { userId, spaceId: spaceA }
  const client = pgliteClient(database)
  const inserted = await database.query<{ xid: string; seq: string }>(
    `SELECT xid::text,seq::text FROM record_change
     WHERE row_id IN ('01990000-0000-7000-8000-000000001320','01990000-0000-7000-8000-000000001321')
     ORDER BY record_change.seq`,
  )
  let read = await readRecordChanges(
    client,
    identity,
    { xid: BigInt(inserted.rows[0]!.xid), seq: BigInt(inserted.rows[0]!.seq) - 1n },
    1,
    RECORD_CHANGE_LOGGED_TABLES,
  )
  const seqs: bigint[] = read.resetRequired ? [] : read.changes.map((change) => change.seq)
  for (let page = 0; page < 20; page += 1) {
    read = await readRecordChanges(client, identity, read.cursor, 1, RECORD_CHANGE_LOGGED_TABLES)
    if (read.resetRequired || read.changes.length === 0) break
    seqs.push(...read.changes.map((change) => change.seq))
  }
  expect(seqs).toEqual(inserted.rows.map((row) => BigInt(row.seq)))
  expect(seqs).toEqual([999n, 1000n])
  await database.query('DELETE FROM record_change WHERE seq=ANY($1::bigint[])', [
    inserted.rows.map((row) => row.seq),
  ])
})

test('an underfull page advances past unserved rows and leaves no served lag', async () => {
  await database.exec(`SELECT setval('record_change_seq_seq', 998)`)
  const inserted = await database.query<{ xid: string; seq: string }>(
    `INSERT INTO record_change(space_id,table_name,row_id,op)
     VALUES ($1,'hub_task',$2,'upsert'),($1,'hub_task',$3,'upsert')
     RETURNING xid::text,seq::text`,
    [spaceA, '01990000-0000-7000-8000-000000001322', '01990000-0000-7000-8000-000000001323'],
  )
  const after = {
    xid: BigInt(inserted.rows[0]!.xid),
    seq: BigInt(inserted.rows[0]!.seq) - 1n,
  }
  const page = await readRecordChanges(pgliteClient(database), identity(spaceA), after, 10, [
    'project',
  ])
  expect(page.resetRequired).toBe(false)
  if (!page.resetRequired) {
    expect(page.changes).toEqual([])
    expect(page.cursor).toEqual({ xid: BigInt(inserted.rows[1]!.xid), seq: 1000n })
    expect(page.lag).toBe(0)
  }
  await database.query('DELETE FROM record_change WHERE seq=ANY($1::bigint[])', [
    inserted.rows.map((row) => row.seq),
  ])
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

test('record feed materialization collapses entries, reads each space, and preserves hidden-note deletes', async () => {
  const taskA = '01990000-0000-7000-8000-000000001360'
  const taskB = '01990000-0000-7000-8000-000000001361'
  const hiddenNote = '01990000-0000-7000-8000-000000001362'
  const invisibleTask = '01990000-0000-7000-8000-000000001363'
  const owner = '01990000-0000-7000-8000-000000001364'
  await database.exec(`
    RESET ROLE;
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at)
    VALUES
      ('${taskA}','${spaceA}','${PLATFORM_NAME}','DEV-1360','${PLATFORM_NAME}','old','local',now(),now(),now(),now()),
      ('${taskB}','${spaceB}','${PLATFORM_NAME}','DEV-1361','${PLATFORM_NAME}','space b','local',now(),now(),now(),now());
    UPDATE hub_task SET title='last' WHERE id='${taskA}';
    INSERT INTO "user" (id,email,name,created_at) VALUES
      ('${owner}','feed-owner@example.test','Feed owner',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at) VALUES
      ('01990000-0000-7000-8000-000000001365','${spaceA}','${owner}','owner','write',now());
    INSERT INTO hub_note
      (id,space_id,project_name,number,project,text,anchors,sightings,created_at,last_seen_at,updated_at)
    VALUES ('${hiddenNote}','${spaceA}','${PLATFORM_NAME}',1362,'${PLATFORM_NAME}','hidden','[]',1,now(),now(),now());
  `)
  await database.transaction(async (transaction) => {
    const tx = pgliteSql(transaction)
    await tx`SET ROLE ${tx.unsafe(RECORD_ACTOR_ROLE)}`
    await bindTenant(tx, { userId: owner, spaceId: spaceA })
    await tx`SELECT public.hub_note_set_hidden(${hiddenNote}::uuid,'spam',${owner}::uuid)`
  })
  const result = await database.transaction(async (transaction) => {
    const tx = pgliteSql(transaction)
    await tx`SET ROLE ${tx.unsafe(RECORD_ACTOR_ROLE)}`
    await bindTenant(tx, { userId, spaceId: spaceA, spaceIds: [spaceA, spaceB] })
    return materializeHostedRecordChangePage(tx, {
      resetRequired: false,
      cursor: { xid: 9n, seq: 9n },
      lag: 0,
      more: false,
      changes: [
        { xid: 1n, seq: 1n, table: 'hub_task', id: taskA, space: spaceA, op: 'upsert' },
        { xid: 2n, seq: 2n, table: 'hub_task', id: taskA, space: spaceA, op: 'upsert' },
        { xid: 3n, seq: 3n, table: 'hub_task', id: taskB, space: spaceB, op: 'upsert' },
        { xid: 4n, seq: 4n, table: 'hub_note', id: hiddenNote, space: spaceA, op: 'upsert' },
        { xid: 5n, seq: 5n, table: 'hub_task', id: invisibleTask, space: spaceA, op: 'upsert' },
      ],
    })
  })
  expect(result.changes).toEqual([
    expect.objectContaining({
      table: 'hub_task',
      id: taskA,
      space: spaceA,
      row: expect.objectContaining({ title: 'last' }),
    }),
    expect.objectContaining({
      table: 'hub_task',
      id: taskB,
      space: spaceB,
      row: expect.objectContaining({ title: 'space b' }),
    }),
    { table: 'hub_note', id: hiddenNote, space: spaceA, op: 'delete' },
  ])
  await database.exec(`
    RESET ROLE;
    DELETE FROM hub_note WHERE id='${hiddenNote}';
    DELETE FROM hub_task WHERE id IN ('${taskA}','${taskB}');
    DELETE FROM record_change WHERE row_id=ANY(ARRAY['${hiddenNote}','${taskA}','${taskB}']::uuid[]);
    DELETE FROM hub_change WHERE row_id=ANY(ARRAY['${hiddenNote}','${taskA}','${taskB}']::uuid[]);
    DELETE FROM hub_change_head WHERE space_id IN ('${spaceA}','${spaceB}');
    DELETE FROM membership WHERE user_id='${owner}';
    DELETE FROM "user" WHERE id='${owner}';
  `)
})

test('record feed materialization preserves both sides of a cross-space move', async () => {
  const movedTask = '01990000-0000-7000-8000-000000001366'
  await database.exec(`
    RESET ROLE;
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at)
    VALUES
      ('${movedTask}','${spaceB}','${PLATFORM_NAME}','DEV-1366','${PLATFORM_NAME}','moved','local',now(),now(),now(),now());
  `)
  const result = await database.transaction(async (transaction) => {
    const tx = pgliteSql(transaction)
    await tx`SET ROLE ${tx.unsafe(RECORD_ACTOR_ROLE)}`
    await bindTenant(tx, { userId, spaceId: spaceA, spaceIds: [spaceA, spaceB] })
    return materializeHostedRecordChangePage(tx, {
      resetRequired: false,
      cursor: { xid: 2n, seq: 2n },
      lag: 0,
      more: false,
      changes: [
        { xid: 1n, seq: 1n, table: 'hub_task', id: movedTask, space: spaceA, op: 'delete' },
        { xid: 1n, seq: 2n, table: 'hub_task', id: movedTask, space: spaceB, op: 'upsert' },
      ],
    })
  })
  expect(result.changes).toEqual([
    { table: 'hub_task', id: movedTask, space: spaceA, op: 'delete' },
    expect.objectContaining({
      table: 'hub_task',
      id: movedTask,
      space: spaceB,
      op: 'upsert',
      row: expect.objectContaining({ title: 'moved' }),
    }),
  ])
  await database.exec(`
    RESET ROLE;
    DELETE FROM hub_task WHERE id='${movedTask}';
    DELETE FROM record_change WHERE row_id='${movedTask}';
    DELETE FROM hub_change WHERE row_id='${movedTask}';
    DELETE FROM hub_change_head WHERE space_id='${spaceB}';
  `)
})

test('later row suppression returns one key for many later changes to the same row', async () => {
  const sql = pgliteSql(database)
  await bind(database, spaceH)
  const repeatedId = '01990000-0000-7000-8000-000000001319'
  await database.exec(`
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at)
    VALUES ('${repeatedId}','${spaceH}','${PLATFORM_NAME}','DEV-1401','${PLATFORM_NAME}','first','local',now(),now(),now(),now());
    UPDATE hub_task SET title='second' WHERE id='${repeatedId}';
    UPDATE hub_task SET title='third' WHERE id='${repeatedId}';
    UPDATE hub_task SET title='fourth' WHERE id='${repeatedId}';
  `)

  expect(await laterRowKeys(sql, spaceH, 1, ['hub_task'], [repeatedId])).toEqual([
    `hub_task:${repeatedId}`,
  ])
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

test('change pages traverse numeric sequences exactly once in ascending order', async () => {
  const sql = pgliteSql(database)
  await bind(database, spaceE)
  await database.exec(`
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at)
    SELECT
      ('01990000-0000-7000-8000-' || lpad(series::text,12,'0'))::uuid,
      '${spaceE}',
      '${PLATFORM_NAME}',
      'DEV-' || series,
      '${PLATFORM_NAME}',
      'task ' || series,
      'local',
      now(),
      now(),
      now(),
      now()
    FROM generate_series(2000,2122) AS series;
  `)

  const sequences: number[] = []
  let after = 0
  let head = 0
  while (true) {
    const page = await readHostedChangesInTransaction(sql, identity(spaceE), {
      after,
      limit: 7,
      tables: ['hub_task'],
    })
    const pageSequences = page.changes.map((change) => change.sequence)
    expect(pageSequences.length).toBeGreaterThan(0)
    expect(page.next).toBe(pageSequences.at(-1)!)
    sequences.push(...pageSequences)
    after = page.next
    head = page.head
    if (!page.more) break
  }

  expect(sequences).toEqual(Array.from({ length: head }, (_, index) => index + 1))
  expect(after).toBe(head)
})

test('a delete is withheld when a later page still has an entry for the same row', async () => {
  const sql = pgliteSql(database)
  await bind(database, spaceF)
  await database.exec(`
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at)
    VALUES ('${recreatedId}','${spaceF}','${PLATFORM_NAME}','DEV-f','${PLATFORM_NAME}','first','local',now(),now(),now(),now());
    DELETE FROM hub_task WHERE id='${recreatedId}';
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at)
    VALUES ('${recreatedId}','${spaceF}','${PLATFORM_NAME}','DEV-f','${PLATFORM_NAME}','recreated','local',now(),now(),now(),now());
  `)
  const withheld = await readHostedChangesInTransaction(sql, identity(spaceF), {
    after: 1,
    limit: 1,
    tables: ['hub_task'],
  })
  expect(withheld).toMatchObject({ next: 2, more: true, changes: [] })

  await bind(database, spaceG)
  await database.exec(`
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at)
    VALUES ('${lastDeleteId}','${spaceG}','${PLATFORM_NAME}','DEV-g','${PLATFORM_NAME}','only','local',now(),now(),now(),now());
    DELETE FROM hub_task WHERE id='${lastDeleteId}';
  `)
  const delivered = await readHostedChangesInTransaction(sql, identity(spaceG), {
    after: 1,
    limit: 1,
    tables: ['hub_task'],
  })
  expect(delivered).toEqual({
    head: 2,
    oldest: 1,
    next: 2,
    more: false,
    resetRequired: false,
    changes: [{ sequence: 2, table: 'hub_task', id: lastDeleteId, op: 'delete' }],
  })
})
