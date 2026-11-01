import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'

const migrationUrl = process.env.BOTTEGA_TEST_BOARD_READER_RUN_MIGRATION_URL
const realPostgres = migrationUrl ? describe : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')
const expandMigration = '20261101151116_dev_2002_board_receipt_reader_run_record_id'
let priorMigrations = ''

const USER_ID = '02990000-0000-7000-8000-000000000401'
const MACHINE_ID = '02990000-0000-7000-8000-000000000402'
const RUN_ID = '02990000-0000-7000-8000-000000000403'
const MESSAGE_ID = '02990000-0000-7000-8000-000000000404'

realPostgres('populated board reader run migration', () => {
  beforeAll(() => {
    priorMigrations = mkdtempSync(join(tmpdir(), 'dev-2002-prior-migrations-'))
    for (const folder of readdirSync(migrationsFolder).filter((name) => name < expandMigration)) {
      cpSync(join(migrationsFolder, folder), join(priorMigrations, folder), { recursive: true })
    }
  })

  afterAll(() => rmSync(priorMigrations, { recursive: true, force: true }))

  test('backfills a run reader and leaves a session reader NULL', async () => {
    const sql = new SQL(migrationUrl!)
    try {
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorMigrations })
      await sql.unsafe('ALTER TABLE board_message NO FORCE ROW LEVEL SECURITY')
      await sql.unsafe('ALTER TABLE board_receipt NO FORCE ROW LEVEL SECURITY')
      await sql.unsafe('ALTER TABLE run NO FORCE ROW LEVEL SECURITY')
      await sql`
        INSERT INTO "user" (id,email,name,created_at)
        VALUES (${USER_ID},'reader-run@example.test','Reader run',now())
      `
      await sql`
        INSERT INTO machine (id,user_id,name,registered_at,last_seen)
        VALUES (${MACHINE_ID},${USER_ID},'reader-run-machine',now(),now())
      `
      await sql`
        INSERT INTO run
          (id,machine_id,started_by_user_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,
           probe,status,turn,no_failover,automatic_failover,work_preserved,created_at,updated_at)
        VALUES
          (${RUN_ID},${MACHINE_ID},${USER_ID},now(),'codex','implement','sha',1,'proof',false,
           'ok',1,false,false,false,now(),now())
      `
      await sql`
        INSERT INTO board_message
          (id,author_user_id,kind,purpose,audience,title,body,ack_required,expires_at,created_at)
        VALUES
          (${MESSAGE_ID},${USER_ID},'notice','information','operator','proof','proof',false,
           now() + interval '1 day',now())
      `
      await sql`
        INSERT INTO board_receipt
          (id,message_id,reader_user_id,reader_session,audience_at_posting)
        VALUES
          ('02990000-0000-7000-8000-000000000405',${MESSAGE_ID},${USER_ID},${`run:${RUN_ID}`},true),
          ('02990000-0000-7000-8000-000000000406',${MESSAGE_ID},${USER_ID},'session-reader',true)
      `

      await migrate(drizzle({ client: sql }), { migrationsFolder })
      const rows = await sql`
        SELECT reader_session,reader_run_record_id::text AS reader_run_record_id
        FROM board_receipt WHERE message_id=${MESSAGE_ID} ORDER BY reader_session
      `
      expect(rows).toEqual([
        { reader_session: `run:${RUN_ID}`, reader_run_record_id: RUN_ID },
        { reader_session: 'session-reader', reader_run_record_id: null },
      ])
    } finally {
      await sql.close()
    }
  })
})
