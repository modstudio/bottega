import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { RECORD_ACTOR_ROLE, RECORD_OWNER_ROLE } from './schema.ts'
import {
  HUB_CHANGE_RETENTION_DAYS,
  HUB_CHANGE_SOURCE_EXCLUSIONS,
  HUB_CHANGE_SOURCES,
} from './schema-hub.ts'

const migrationsFolder = join(fileURLToPath(new URL('.', import.meta.url)), 'migrations')
const spaceA = '01990000-0000-7000-8000-000000001240'
const spaceB = '01990000-0000-7000-8000-000000001241'
const taskId = '01990000-0000-7000-8000-000000001242'
const intervalId = '01990000-0000-7000-8000-000000001243'
const movedTaskId = '01990000-0000-7000-8000-000000001244'
const sendId = '01990000-0000-7000-8000-000000001245'
const recipientId = '01990000-0000-7000-8000-000000001246'
const wrongSpaceRecipientId = '01990000-0000-7000-8000-000000001247'
const pruneSpaceA = '01990000-0000-7000-8000-000000001248'
const pruneSpaceB = '01990000-0000-7000-8000-000000001249'
const oldPruneTaskA = '01990000-0000-7000-8000-000000001250'
const newPruneTaskA = '01990000-0000-7000-8000-000000001251'
const oldPruneTaskB = '01990000-0000-7000-8000-000000001252'
const newPruneTaskB = '01990000-0000-7000-8000-000000001253'
const afterPruneTask = '01990000-0000-7000-8000-000000001254'

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
    INSERT INTO space (id,name,slug,created_at) VALUES
      ('${spaceA}','Change log A','change-log-a',now()),
      ('${spaceB}','Change log B','change-log-b',now());
  `)
  return database
}

async function bindActor(database: PGlite, spaceId: string) {
  await database.exec(`
    SET ROLE ${RECORD_ACTOR_ROLE};
    SELECT set_config('app.space_id','${spaceId}',false);
    SELECT set_config('app.space_ids','${spaceId}',false);
  `)
}

async function resetSession(database: PGlite) {
  await database.exec(`
    RESET ROLE;
    SELECT set_config('app.space_id','',false);
    SELECT set_config('app.space_ids','',false);
  `)
}

let database: PGlite

beforeAll(async () => {
  database = await createRecordDatabase()
})

afterAll(async () => {
  if (database) await database.close()
})

test('change-log triggers cover every synced table and recipient changes map to sends', async () => {
  const candidateTables = (
    await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables candidate
      WHERE table_schema='public'
        AND table_type='BASE TABLE'
        AND table_name LIKE 'hub\\_%' ESCAPE '\\'
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema=candidate.table_schema
            AND table_name=candidate.table_name
            AND column_name='space_id'
        )
      ORDER BY table_name
    `)
  ).rows.map(({ table_name }) => table_name)
  const classifications = [
    ...HUB_CHANGE_SOURCES.rows,
    ...Object.keys(HUB_CHANGE_SOURCES.children),
    ...Object.keys(HUB_CHANGE_SOURCE_EXCLUSIONS),
  ]
  expect(new Set(classifications).size).toBe(classifications.length)
  expect(candidateTables).toEqual(classifications.toSorted())

  const rows = (
    await database.query<{
      table_name: string
      function_name: string
      enabled: string
      trigger_type: number
    }>(
      `
      SELECT c.relname table_name, p.proname function_name, t.tgenabled enabled,
        t.tgtype::int trigger_type
      FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE NOT t.tgisinternal
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname
    `,
      [[...HUB_CHANGE_SOURCES.rows, ...Object.keys(HUB_CHANGE_SOURCES.children)]],
    )
  ).rows

  expect(rows).toHaveLength(
    HUB_CHANGE_SOURCES.rows.length + Object.keys(HUB_CHANGE_SOURCES.children).length,
  )
  for (const table of HUB_CHANGE_SOURCES.rows) {
    expect(rows).toContainEqual({
      table_name: table,
      function_name: 'hub_change_log_row',
      enabled: 'O',
      trigger_type: 29,
    })
  }
  for (const table of Object.keys(HUB_CHANGE_SOURCES.children)) {
    expect(rows).toContainEqual({
      table_name: table,
      function_name: 'hub_change_log_send_recipient',
      enabled: 'O',
      trigger_type: 29,
    })
  }
})

test('tenant and owner writes append gapless, space-scoped change entries', async () => {
  await bindActor(database, spaceA)
  await database.exec(`
    INSERT INTO hub_task (
      id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at
    ) VALUES (
      '${taskId}','${spaceA}','fixture-project','DEV-1240','fixture-project','first','local',
      now(),now(),now(),now()
    );
    UPDATE hub_task SET title='second' WHERE id='${taskId}';
    UPDATE hub_task SET title=title WHERE id='${taskId}';
    UPDATE hub_task SET deleted_at=now() WHERE id='${taskId}';
  `)
  expect(
    (
      await database.query<{ sequence: number; op: string }>(
        `SELECT sequence::int,op FROM hub_change WHERE space_id=$1 ORDER BY sequence`,
        [spaceA],
      )
    ).rows,
  ).toEqual([
    { sequence: 1, op: 'upsert' },
    { sequence: 2, op: 'upsert' },
    { sequence: 3, op: 'upsert' },
  ])

  await database.exec(`
    BEGIN;
    UPDATE hub_task SET title='rolled back' WHERE id='${taskId}';
    ROLLBACK;
  `)
  expect(
    (
      await database.query<{ sequence: number; entries: number }>(
        `SELECT h.sequence::int,count(c.*)::int entries
         FROM hub_change_head h
         LEFT JOIN hub_change c ON c.space_id=h.space_id
         WHERE h.space_id=$1 GROUP BY h.sequence`,
        [spaceA],
      )
    ).rows,
  ).toEqual([{ sequence: 3, entries: 3 }])
  await database.exec(`UPDATE hub_task SET title='after rollback' WHERE id='${taskId}'`)
  expect(
    (
      await database.query<{ sequence: number }>(
        `SELECT sequence::int FROM hub_change WHERE space_id=$1 ORDER BY sequence`,
        [spaceA],
      )
    ).rows,
  ).toEqual([1, 2, 3, 4].map((sequence) => ({ sequence })))

  await database.exec(`
    INSERT INTO hub_interval (
      id,space_id,source,start_at,end_at,ref,updated_at
    ) VALUES ('${intervalId}','${spaceA}','codex',now(),now(),'interval-proof',now());
    DELETE FROM hub_interval WHERE id='${intervalId}';
  `)
  expect(
    (
      await database.query<{ table_name: string; row_id: string; op: string }>(
        `SELECT table_name,row_id::text,op FROM hub_change
         WHERE space_id=$1 ORDER BY sequence DESC LIMIT 1`,
        [spaceA],
      )
    ).rows[0],
  ).toEqual({ table_name: 'hub_interval', row_id: intervalId, op: 'delete' })

  await database.exec(`
    INSERT INTO hub_task (
      id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at
    ) VALUES (
      '${movedTaskId}','${spaceA}','fixture-project','DEV-1240-MOVE','fixture-project','move','local',
      now(),now(),now(),now()
    );
  `)
  await resetSession(database)
  await database.exec(`
    SET ROLE ${RECORD_OWNER_ROLE};
    ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
    UPDATE hub_task SET space_id='${spaceB}' WHERE id='${movedTaskId}';
    ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;
  `)
  expect(
    (
      await database.query<{ space_id: string; op: string }>(
        `SELECT space_id::text,op FROM hub_change WHERE row_id=$1 ORDER BY space_id`,
        [movedTaskId],
      )
    ).rows,
  ).toEqual([
    { space_id: spaceA, op: 'upsert' },
    { space_id: spaceA, op: 'delete' },
    { space_id: spaceB, op: 'upsert' },
  ])

  await resetSession(database)
  await bindActor(database, spaceA)
  await database.exec(`
    INSERT INTO hub_send (
      id,space_id,at,"window",recipients,projects,items,status,test,created_at,machine
    ) VALUES ('${sendId}','${spaceA}',now(),'day','one','fixture-project',1,'pending',0,now(),'test');
    INSERT INTO hub_send_recipient (id,space_id,send_id,name,email,created_at)
    VALUES ('${recipientId}','${spaceA}','${sendId}','Test','test@example.com',now());
  `)
  expect(
    (
      await database.query<{ row_id: string; occurrences: number }>(
        `SELECT row_id::text,count(*)::int occurrences FROM hub_change
         WHERE table_name='hub_send' AND row_id=$1 GROUP BY row_id`,
        [sendId],
      )
    ).rows,
  ).toEqual([{ row_id: sendId, occurrences: 2 }])

  await resetSession(database)
  const changeStateBeforeInvalidRecipient = (
    await database.query<{ space_id: string; sequence: number; entries: number }>(`
      SELECT h.space_id::text, h.sequence::int, count(c.*)::int entries
      FROM hub_change_head h
      LEFT JOIN hub_change c ON c.space_id=h.space_id
      GROUP BY h.space_id,h.sequence
      ORDER BY h.space_id
    `)
  ).rows
  await bindActor(database, spaceB)
  await expect(
    database.query(
      `INSERT INTO hub_send_recipient (id,space_id,send_id,name,email,created_at)
       VALUES ($1,$2,$3,'Wrong space','wrong-space@example.com',now())`,
      [wrongSpaceRecipientId, spaceB, sendId],
    ),
  ).rejects.toThrow()
  await resetSession(database)
  expect(
    (
      await database.query<{ space_id: string; sequence: number; entries: number }>(`
        SELECT h.space_id::text, h.sequence::int, count(c.*)::int entries
        FROM hub_change_head h
        LEFT JOIN hub_change c ON c.space_id=h.space_id
        GROUP BY h.space_id,h.sequence
        ORDER BY h.space_id
      `)
    ).rows,
  ).toEqual(changeStateBeforeInvalidRecipient)

  await database.exec(`
    SET ROLE ${RECORD_OWNER_ROLE};
    ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
    UPDATE hub_task SET title='owner update' WHERE id='${movedTaskId}';
    ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;
  `)
  expect(
    (
      await database.query<{ op: string }>(
        `SELECT op FROM hub_change WHERE space_id=$1 AND row_id=$2 ORDER BY sequence DESC LIMIT 1`,
        [spaceB, movedTaskId],
      )
    ).rows,
  ).toEqual([{ op: 'upsert' }])

  await resetSession(database)
  await bindActor(database, spaceA)
  expect(
    (await database.query(`SELECT 1 FROM hub_change WHERE space_id=$1`, [spaceB])).rows,
  ).toEqual([])
  await expect(
    database.query(
      `INSERT INTO hub_change_head(space_id,sequence) VALUES ($1,1)
       ON CONFLICT(space_id) DO UPDATE SET sequence=hub_change_head.sequence+1`,
      [spaceB],
    ),
  ).rejects.toThrow()
})

test('actor pruning crosses spaces under forced row security while preserving heads', async () => {
  await resetSession(database)
  await database.exec(`
    INSERT INTO space (id,name,slug,created_at) VALUES
      ('${pruneSpaceA}','Prune A','prune-a',now()),
      ('${pruneSpaceB}','Prune B','prune-b',now());
  `)
  for (const [spaceId, oldTaskId, newTaskId, suffix] of [
    [pruneSpaceA, oldPruneTaskA, newPruneTaskA, 'A'],
    [pruneSpaceB, oldPruneTaskB, newPruneTaskB, 'B'],
  ] as const) {
    await bindActor(database, spaceId)
    await database.query(
      `INSERT INTO hub_task (
        id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at
      ) VALUES
        ($1,$2,'fixture-project',$3,'fixture-project','old','local',now(),now(),now(),now()),
        ($4,$2,'fixture-project',$5,'fixture-project','new','local',now(),now(),now(),now())`,
      [oldTaskId, spaceId, `DEV-1240-OLD-${suffix}`, newTaskId, `DEV-1240-NEW-${suffix}`],
    )
    await resetSession(database)
  }
  await database.exec(`SET ROLE ${RECORD_OWNER_ROLE}`)
  await database.query(
    `UPDATE hub_change SET at=now() - interval '2 days' - $1 * interval '1 day'
     WHERE row_id IN ($2,$3)`,
    [HUB_CHANGE_RETENTION_DAYS, oldPruneTaskA, oldPruneTaskB],
  )
  await resetSession(database)

  expect(
    (
      await database.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1`,
        [RECORD_OWNER_ROLE],
      )
    ).rows,
  ).toEqual([{ rolname: RECORD_OWNER_ROLE, rolsuper: false, rolbypassrls: false }])
  expect(
    (
      await database.query<{ relforcerowsecurity: boolean }>(
        `SELECT relforcerowsecurity FROM pg_class WHERE oid='hub_change'::regclass`,
      )
    ).rows,
  ).toEqual([{ relforcerowsecurity: true }])

  await database.exec(`SET ROLE ${RECORD_ACTOR_ROLE}`)
  expect(
    (
      await database.query<{ deleted: number }>(
        `SELECT hub_change_prune($1 * interval '1 day')::int AS deleted`,
        [HUB_CHANGE_RETENTION_DAYS],
      )
    ).rows,
  ).toEqual([{ deleted: 2 }])
  await database.exec(`SELECT set_config('app.space_id','${pruneSpaceA}',false)`)
  expect(
    (
      await database.query<{ deleted: string }>(
        `DELETE FROM hub_change RETURNING row_id::text AS deleted`,
      )
    ).rows,
  ).toEqual([])
  await resetSession(database)

  const retained = (
    await database.query<{ space_id: string; row_id: string }>(
      `SELECT space_id::text,row_id::text FROM hub_change
       WHERE space_id IN ($1,$2) ORDER BY space_id,sequence`,
      [pruneSpaceA, pruneSpaceB],
    )
  ).rows
  expect(retained).toEqual([
    { space_id: pruneSpaceA, row_id: newPruneTaskA },
    { space_id: pruneSpaceB, row_id: newPruneTaskB },
  ])
  expect(
    (
      await database.query<{ space_id: string; sequence: number }>(
        `SELECT space_id::text,sequence::int FROM hub_change_head
         WHERE space_id IN ($1,$2) ORDER BY space_id`,
        [pruneSpaceA, pruneSpaceB],
      )
    ).rows,
  ).toEqual([
    { space_id: pruneSpaceA, sequence: 2 },
    { space_id: pruneSpaceB, sequence: 2 },
  ])

  await database.exec(`SET ROLE ${RECORD_ACTOR_ROLE}`)
  await expect(database.query(`SELECT hub_change_prune(interval '23 hours')`)).rejects.toThrow(
    'hub change retention must be at least one day',
  )
  await resetSession(database)
  expect(
    (
      await database.query<{ entries: number }>(
        `SELECT count(*)::int AS entries FROM hub_change WHERE space_id IN ($1,$2)`,
        [pruneSpaceA, pruneSpaceB],
      )
    ).rows,
  ).toEqual([{ entries: 2 }])

  await database.exec(`SET ROLE ${RECORD_OWNER_ROLE}`)
  await database.query(
    `UPDATE hub_change SET at=now() - interval '2 days' - $1 * interval '1 day'
     WHERE space_id IN ($2,$3)`,
    [HUB_CHANGE_RETENTION_DAYS, pruneSpaceA, pruneSpaceB],
  )
  await resetSession(database)
  await database.exec(`SET ROLE ${RECORD_ACTOR_ROLE}`)
  await database.query(`SELECT hub_change_prune($1 * interval '1 day')`, [
    HUB_CHANGE_RETENTION_DAYS,
  ])
  await resetSession(database)
  await bindActor(database, pruneSpaceA)
  await database.query(
    `INSERT INTO hub_task (
      id,space_id,project_name,key,project,title,source,first_seen,last_seen,created_at,updated_at
    ) VALUES ($1,$2,'fixture-project','DEV-1240-AFTER','fixture-project','after prune',
      'local',now(),now(),now(),now())`,
    [afterPruneTask, pruneSpaceA],
  )
  expect(
    (
      await database.query<{ sequence: number; row_id: string }>(
        `SELECT sequence::int,row_id::text FROM hub_change WHERE space_id=$1`,
        [pruneSpaceA],
      )
    ).rows,
  ).toEqual([{ sequence: 3, row_id: afterPruneTask }])
})
