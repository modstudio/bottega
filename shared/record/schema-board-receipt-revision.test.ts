import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { RECORD_ACTOR_ROLE } from './schema.ts'

/**
 * A reader's acknowledgement changes only its own receipt row, so the change feed pages on the
 * message revision instead. The definer function that advances that revision runs as the table
 * owner, which FORCE row level security applies to as well, and the owner holds only the three
 * owner policies this migration declares.
 */
const migrationsFolder = join(fileURLToPath(new URL('.', import.meta.url)), 'migrations')
const advanceFunction = 'public.board_message_advance_receipt_revision'
const nextRevision = "nextval('public.board_message_revision'::regclass)"

const spaceId = '01990000-0000-7000-8000-000000001360'
const projectId = '01990000-0000-7000-8000-000000001361'
const authorUserId = '01990000-0000-7000-8000-000000001362'
const readerUserId = '01990000-0000-7000-8000-000000001363'
const otherReaderUserId = '01990000-0000-7000-8000-000000001364'
const authorMembershipId = '01990000-0000-7000-8000-000000001365'
const readerMembershipId = '01990000-0000-7000-8000-000000001366'
const deliveredMessageId = '01990000-0000-7000-8000-000000001367'
const foreignReceiptMessageId = '01990000-0000-7000-8000-000000001368'
const deliveredReceiptId = '01990000-0000-7000-8000-000000001369'
const foreignReceiptId = '01990000-0000-7000-8000-000000001370'
const readerSession = 'receipt-revision-reader'
const otherReaderSession = 'receipt-revision-other'

async function applyMigration(transaction: Transaction, migration: MigrationMeta) {
  for (const statement of migration.sql) await transaction.exec(statement)
  await transaction.query(
    'INSERT INTO drizzle.__drizzle_migrations (hash,created_at,name) VALUES ($1,$2,$3)',
    [migration.hash, migration.folderMillis, migration.name],
  )
}

function seedSql(): string {
  const notice = (id: string) => `
    INSERT INTO board_message (
      id, author_user_id, kind, purpose, audience, title, body, ack_required, expires_at,
      created_at, scope_project_ids
    ) VALUES (
      '${id}', '${authorUserId}', 'notice', 'information', 'project:receipt-revision',
      'Acknowledgement proof', 'body', false, now() + interval '1 day', now(),
      ARRAY['${projectId}']::uuid[]
    );`
  return `
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${spaceId}','Receipt revision','receipt-revision',now());
    INSERT INTO "user" (id,email,name,created_at) VALUES
      ('${authorUserId}','receipt-revision-author@example.test','Author',now()),
      ('${readerUserId}','receipt-revision-reader@example.test','Reader',now()),
      ('${otherReaderUserId}','receipt-revision-other@example.test','Other reader',now());
    INSERT INTO membership (id,space_id,user_id,role,permission,created_at) VALUES
      ('${authorMembershipId}','${spaceId}','${authorUserId}','member','write',now()),
      ('${readerMembershipId}','${spaceId}','${readerUserId}','member','write',now());
    INSERT INTO project (id,space_id,name,created_at)
    VALUES ('${projectId}','${spaceId}','receipt-revision',now());
    ${notice(deliveredMessageId)}
    ${notice(foreignReceiptMessageId)}
    INSERT INTO board_receipt (
      id,message_id,reader_user_id,reader_session,audience_at_posting,delivered_at,acknowledged_at
    ) VALUES
      ('${deliveredReceiptId}','${deliveredMessageId}','${readerUserId}','${readerSession}',true,now(),NULL),
      ('${foreignReceiptId}','${foreignReceiptMessageId}','${otherReaderUserId}','${otherReaderSession}',true,now(),now());
  `
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
  await database.exec(`RESET ROLE;${seedSql()}`)
  return database
}

async function bindActor(database: PGlite, userId: string) {
  await database.exec(`
    SET ROLE ${RECORD_ACTOR_ROLE};
    SELECT set_config('app.user_id','${userId}',false);
    SELECT set_config('app.space_id','${spaceId}',false);
    SELECT set_config('app.space_ids','${spaceId}',false);
  `)
}

async function resetSession(database: PGlite) {
  await database.exec(`
    RESET ROLE;
    SELECT set_config('app.user_id','',false);
    SELECT set_config('app.space_id','',false);
    SELECT set_config('app.space_ids','',false);
  `)
}

async function messageRevision(database: PGlite, messageId: string): Promise<string> {
  const rows = await database.query<{ revision: string }>(
    'SELECT revision FROM board_message WHERE id = $1',
    [messageId],
  )
  expect(rows.rows).toHaveLength(1)
  return String(rows.rows[0]!.revision)
}

async function advanceRevision(database: PGlite, messageId: string): Promise<boolean> {
  const rows = await database.query<{ advanced: boolean }>(
    `SELECT ${advanceFunction}($1::uuid) AS advanced`,
    [messageId],
  )
  return rows.rows[0]!.advanced
}

let database: PGlite

beforeAll(async () => {
  database = await createRecordDatabase()
})

afterAll(async () => {
  if (database) await database.close()
})

test('a reader that can see the message still cannot advance its revision directly', async () => {
  await bindActor(database, readerUserId)
  try {
    const before = await messageRevision(database, deliveredMessageId)
    const updated = await database.query<{ id: string }>(
      `UPDATE board_message SET revision = ${nextRevision} WHERE id = $1 RETURNING id`,
      [deliveredMessageId],
    )
    expect(updated.rows).toEqual([])
    expect(await messageRevision(database, deliveredMessageId)).toBe(before)
  } finally {
    await resetSession(database)
  }
})

test('the function refuses an unacknowledged receipt and another reader\u2019s receipt', async () => {
  await bindActor(database, readerUserId)
  try {
    const unacknowledgedBefore = await messageRevision(database, deliveredMessageId)
    const foreignBefore = await messageRevision(database, foreignReceiptMessageId)
    expect(await advanceRevision(database, deliveredMessageId)).toBeFalse()
    expect(await advanceRevision(database, foreignReceiptMessageId)).toBeFalse()
    expect(await messageRevision(database, deliveredMessageId)).toBe(unacknowledgedBefore)
    expect(await messageRevision(database, foreignReceiptMessageId)).toBe(foreignBefore)
  } finally {
    await resetSession(database)
  }
})

test('force row level security stays on and the owner holds only these three policies', async () => {
  const forced = await database.query<{ relname: string; relforcerowsecurity: boolean }>(`
    SELECT relname, relforcerowsecurity FROM pg_class
    WHERE relnamespace='public'::regnamespace
      AND relname IN ('board_message','board_receipt')
    ORDER BY relname
  `)
  expect(forced.rows).toEqual([
    { relname: 'board_message', relforcerowsecurity: true },
    { relname: 'board_receipt', relforcerowsecurity: true },
  ])
  const ownerPolicies = await database.query<{
    tablename: string
    policyname: string
    cmd: string
  }>(`
    SELECT tablename, policyname, cmd FROM pg_policies
    WHERE schemaname='public' AND tablename IN ('board_message','board_receipt')
      AND 'record_owner' = ANY(roles)
    ORDER BY tablename, policyname
  `)
  expect(ownerPolicies.rows).toEqual([
    { tablename: 'board_message', policyname: 'board_message_owner_select', cmd: 'SELECT' },
    { tablename: 'board_message', policyname: 'board_message_owner_update', cmd: 'UPDATE' },
    { tablename: 'board_receipt', policyname: 'board_receipt_owner_select', cmd: 'SELECT' },
  ])
})
