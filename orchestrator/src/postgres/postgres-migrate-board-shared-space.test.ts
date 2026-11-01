import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { migrationSessionStatements } from '../../../shared/record/migration-session.ts'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'

const validMigrationUrl = process.env.BOTTEGA_TEST_BOARD_SHARED_SPACE_MIGRATION_URL
const invalidMigrationUrl = process.env.BOTTEGA_TEST_BOARD_SHARED_SPACE_INVALID_MIGRATION_URL
const readerRunMigrationUrl = process.env.BOTTEGA_TEST_BOARD_READER_RUN_MIGRATION_URL
const realPostgres = validMigrationUrl && invalidMigrationUrl ? describe : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')
const sharedSpaceMigration = '20261012210147_dev_1217_board_shared_spaces'
let priorMigrations = ''

const AUTHOR_ID = '02990000-0000-7000-8000-000000000201'
const REPLIER_ID = '02990000-0000-7000-8000-000000000202'
const ROOT_ID = '02990000-0000-7000-8000-000000000211'
const REPLY_ID = '02990000-0000-7000-8000-000000000212'
const NESTED_REPLY_ID = '02990000-0000-7000-8000-000000000213'
const READER_MACHINE_ID = '02990000-0000-7000-8000-000000000402'
const READER_RUN_ID = '02990000-0000-7000-8000-000000000403'
const MISSING_READER_RUN_ID = '02990000-0000-7000-8000-000000000407'
const READER_MESSAGE_ID = '02990000-0000-7000-8000-000000000404'
const readerRunMigration = '20261101151116_dev_2002_board_receipt_reader_run_record_id'

async function preparePriorStore(url: string, nested: boolean): Promise<SQL> {
  const sql = new SQL({ url, max: 1 })
  for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
  await migrate(drizzle({ client: sql }), {
    migrationsFolder: priorMigrations,
  })
  await sql.unsafe('ALTER TABLE board_message NO FORCE ROW LEVEL SECURITY')
  await sql`
    INSERT INTO "user" (id,email,name,created_at) VALUES
      (${AUTHOR_ID},'board-migration-author@example.test','Author',now()),
      (${REPLIER_ID},'board-migration-replier@example.test','Replier',now())
  `
  await sql`
    INSERT INTO board_message
      (id,author_user_id,kind,audience,title,body,ack_required,expires_at,created_at)
    VALUES
      (${ROOT_ID},${AUTHOR_ID},'notice','architects','root','root',false,
        now() + interval '1 hour',now())
  `
  await sql`
    INSERT INTO board_message
      (id,author_user_id,kind,thread_root_id,body,ack_required,created_at)
    VALUES (${REPLY_ID},${REPLIER_ID},'reply',${ROOT_ID},'reply',false,now())
  `
  if (nested) {
    await sql`
      INSERT INTO board_message
        (id,author_user_id,kind,thread_root_id,body,ack_required,created_at)
      VALUES (${NESTED_REPLY_ID},${AUTHOR_ID},'reply',${REPLY_ID},'nested',false,now())
    `
  }
  await sql.unsafe('ALTER TABLE board_message FORCE ROW LEVEL SECURITY')
  return sql
}

realPostgres('populated board shared-space migration', () => {
  beforeAll(() => {
    priorMigrations = mkdtempSync(join(tmpdir(), 'dev-1217-prior-migrations-'))
    for (const folder of readdirSync(migrationsFolder).filter(
      (name) => name < sharedSpaceMigration,
    )) {
      cpSync(join(migrationsFolder, folder), join(priorMigrations, folder), {
        recursive: true,
      })
    }
  })

  afterAll(() => rmSync(priorMigrations, { recursive: true, force: true }))

  test('backfills every existing reply anchor from its root author', async () => {
    const sql = await preparePriorStore(validMigrationUrl!, false)
    try {
      for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
      await migrate(drizzle({ client: sql }), { migrationsFolder })
      await sql.unsafe('ALTER TABLE board_message NO FORCE ROW LEVEL SECURITY')
      const rows = await sql`
        SELECT id, thread_root_author_user_id FROM board_message ORDER BY id
      `
      expect(rows).toEqual([
        { id: ROOT_ID, thread_root_author_user_id: AUTHOR_ID },
        { id: REPLY_ID, thread_root_author_user_id: AUTHOR_ID },
      ])
    } finally {
      await sql.close()
    }
  })

  test('rejects existing replies that point at replies and names the count', async () => {
    const sql = await preparePriorStore(invalidMigrationUrl!, true)
    try {
      let failure: unknown
      try {
        for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
        await migrate(drizzle({ client: sql }), { migrationsFolder })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeDefined()
      expect(String((failure as { cause?: unknown }).cause)).toContain(
        'board message migration found 1 replies whose thread_root_id names a reply',
      )
    } finally {
      await sql.close()
    }
  })
})

describe.skipIf(!readerRunMigrationUrl)('populated board reader run migration', () => {
  let readerRunPriorMigrations = ''

  beforeAll(() => {
    readerRunPriorMigrations = mkdtempSync(join(tmpdir(), 'dev-2002-prior-migrations-'))
    for (const folder of readdirSync(migrationsFolder).filter(
      (name) => name < readerRunMigration,
    )) {
      cpSync(join(migrationsFolder, folder), join(readerRunPriorMigrations, folder), {
        recursive: true,
      })
    }
  })

  afterAll(() => rmSync(readerRunPriorMigrations, { recursive: true, force: true }))

  test('backfills a run reader and leaves a session reader NULL', async () => {
    const sql = new SQL({ url: readerRunMigrationUrl!, max: 1 })
    try {
      for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
      await migrate(drizzle({ client: sql }), { migrationsFolder: readerRunPriorMigrations })
      await sql.unsafe('ALTER TABLE board_message NO FORCE ROW LEVEL SECURITY')
      await sql.unsafe('ALTER TABLE board_receipt NO FORCE ROW LEVEL SECURITY')
      await sql.unsafe('ALTER TABLE run NO FORCE ROW LEVEL SECURITY')
      await sql`
        INSERT INTO "user" (id,email,name,created_at)
        VALUES (${AUTHOR_ID},'reader-run@example.test','Reader run',now())
      `
      await sql`
        INSERT INTO machine (id,user_id,name,registered_at,last_seen)
        VALUES (${READER_MACHINE_ID},${AUTHOR_ID},'reader-run-machine',now(),now())
      `
      await sql`
        INSERT INTO run
          (id,space_id,machine_id,started_by_user_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,
           probe,status,turn,no_failover,automatic_failover,work_preserved,created_at,updated_at)
        VALUES
          (${READER_RUN_ID},${PLATFORM_SPACE_ID},${READER_MACHINE_ID},${AUTHOR_ID},now(),'codex','implement','sha',1,'proof',false,
           'ok',1,false,false,false,now(),now())
      `
      await sql`
        INSERT INTO board_message
          (id,author_user_id,kind,purpose,audience,title,body,ack_required,expires_at,created_at)
        VALUES
          (${READER_MESSAGE_ID},${AUTHOR_ID},'notice','information','operator','proof','proof',false,
           now() + interval '1 day',now())
      `
      await sql`
        INSERT INTO board_receipt
          (id,message_id,reader_user_id,reader_session,audience_at_posting)
        VALUES
          ('02990000-0000-7000-8000-000000000405',${READER_MESSAGE_ID},${AUTHOR_ID},${`run:${READER_RUN_ID}`},true),
          ('02990000-0000-7000-8000-000000000406',${READER_MESSAGE_ID},${AUTHOR_ID},'session-reader',true),
          ('02990000-0000-7000-8000-000000000408',${READER_MESSAGE_ID},${AUTHOR_ID},${`run:${MISSING_READER_RUN_ID}`},true)
      `

      for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
      await migrate(drizzle({ client: sql }), { migrationsFolder })
      const rows = await sql`
        SELECT reader_session,reader_run_record_id::text AS reader_run_record_id
        FROM board_receipt WHERE message_id=${READER_MESSAGE_ID} ORDER BY reader_session
      `
      expect(rows).toEqual([
        { reader_session: `run:${READER_RUN_ID}`, reader_run_record_id: READER_RUN_ID },
        {
          reader_session: `run:${MISSING_READER_RUN_ID}`,
          reader_run_record_id: MISSING_READER_RUN_ID,
        },
        { reader_session: 'session-reader', reader_run_record_id: null },
      ])
    } finally {
      await sql.close()
    }
  })
})
