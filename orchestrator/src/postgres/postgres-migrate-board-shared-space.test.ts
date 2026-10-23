import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'

const validMigrationUrl = process.env.BOTTEGA_TEST_BOARD_SHARED_SPACE_MIGRATION_URL
const invalidMigrationUrl = process.env.BOTTEGA_TEST_BOARD_SHARED_SPACE_INVALID_MIGRATION_URL
const realPostgres = validMigrationUrl && invalidMigrationUrl ? describe : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')
const sharedSpaceMigration = '20261012210147_dev_1217_board_shared_spaces'
let priorMigrations = ''

const AUTHOR_ID = '02990000-0000-7000-8000-000000000201'
const REPLIER_ID = '02990000-0000-7000-8000-000000000202'
const ROOT_ID = '02990000-0000-7000-8000-000000000211'
const REPLY_ID = '02990000-0000-7000-8000-000000000212'
const NESTED_REPLY_ID = '02990000-0000-7000-8000-000000000213'

async function preparePriorStore(url: string, nested: boolean): Promise<SQL> {
  const sql = new SQL(url)
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
