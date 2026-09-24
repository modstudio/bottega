import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'

const migrationUrl = process.env.ORCH_TEST_HOSTED_TASK_ID_MIGRATION_URL
const realPostgres = migrationUrl ? describe : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')
const taskIdBackfill = '20260924190350_dev_895_hosted_task_ids_backfill'
let priorMigrations = ''

const PARENT_ID = '01990000-0000-7000-8000-000000008950'
const TASK_ID = '01990000-0000-7000-8000-000000008951'
const COMMENT_ID = '01990000-0000-7000-8000-000000008952'
const DOCUMENT_ID = '01990000-0000-7000-8000-000000008953'
const STATUS_EVENT_ID = '01990000-0000-7000-8000-000000008954'
const NOTE_ID = '01990000-0000-7000-8000-000000008955'

realPostgres('populated hosted task id backfill', () => {
  beforeAll(async () => {
    priorMigrations = mkdtempSync(join(tmpdir(), 'dev-895-prior-migrations-'))
    for (const folder of readdirSync(migrationsFolder).filter((name) => name < taskIdBackfill)) {
      cpSync(join(migrationsFolder, folder), join(priorMigrations, folder), { recursive: true })
    }

    const sql = new SQL(migrationUrl!)
    try {
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorMigrations })
      await sql.unsafe(`SET app.space_id = '${PLATFORM_SPACE_ID}'`)
      await sql`
        INSERT INTO hub_task
          (id, space_id, project_name, key, project, title, status, parent_key, source,
           first_seen, last_seen, created_at, updated_at)
        VALUES
          (${PARENT_ID}, ${PLATFORM_SPACE_ID}, ${PLATFORM_SLUG}, 'DEV-894', ${PLATFORM_SLUG},
           'Parent', 'open', NULL, 'local', now(), now(), now(), now()),
          (${TASK_ID}, ${PLATFORM_SPACE_ID}, ${PLATFORM_SLUG}, 'DEV-895', ${PLATFORM_SLUG},
           'Child', 'open', 'DEV-894', 'local', now(), now(), now(), now())
      `
      await sql`
        INSERT INTO hub_task_comment
          (id, space_id, project_name, task_key, body, created_at, updated_at)
        VALUES
          (${COMMENT_ID}, ${PLATFORM_SPACE_ID}, ${PLATFORM_SLUG}, 'DEV-895', 'Comment', now(), now())
      `
      await sql`
        INSERT INTO hub_task_document
          (id, space_id, project_name, task_key, title, body, version, created_at, updated_at)
        VALUES
          (${DOCUMENT_ID}, ${PLATFORM_SPACE_ID}, ${PLATFORM_SLUG}, 'DEV-895', 'Document', 'Body',
           '1', now(), now())
      `
      await sql`
        INSERT INTO hub_task_status_event
          (id, space_id, project_name, task_key, at, from_status, to_status, created_at, updated_at)
        VALUES
          (${STATUS_EVENT_ID}, ${PLATFORM_SPACE_ID}, ${PLATFORM_SLUG}, 'DEV-895', now(), 'todo',
           'open', now(), now())
      `
      await sql`
        INSERT INTO hub_note
          (id, space_id, project_name, number, project, text, anchors, sightings, created_at,
           last_seen_at, promoted_task, updated_at)
        VALUES
          (${NOTE_ID}, ${PLATFORM_SPACE_ID}, ${PLATFORM_SLUG}, 895, ${PLATFORM_SLUG}, 'Note', '', 1,
           now(), now(), 'DEV-895', now())
      `

      const forcedBefore = await sql`
        SELECT relname
        FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN (
            'hub_task', 'hub_task_comment', 'hub_task_document', 'hub_task_status_event', 'hub_note'
          )
          AND relforcerowsecurity
        ORDER BY relname
      `
      expect(forcedBefore.map((row: { relname: string }) => row.relname)).toEqual([
        'hub_note',
        'hub_task',
        'hub_task_comment',
        'hub_task_document',
        'hub_task_status_event',
      ])

      await sql.unsafe('RESET app.space_id')
      await migrate(drizzle({ client: sql }), { migrationsFolder })
    } finally {
      await sql.close()
    }
  })

  afterAll(() => rmSync(priorMigrations, { recursive: true, force: true }))

  test('backfills task ids as record_owner without an active space and restores FORCE RLS', async () => {
    const sql = new SQL(migrationUrl!)
    try {
      await sql.unsafe(`SET app.space_id = '${PLATFORM_SPACE_ID}'`)
      const [task] = await sql`
        SELECT parent_id FROM hub_task WHERE id = ${TASK_ID}
      `
      const [comment] = await sql`
        SELECT task_id FROM hub_task_comment WHERE id = ${COMMENT_ID}
      `
      const [document] = await sql`
        SELECT task_id FROM hub_task_document WHERE id = ${DOCUMENT_ID}
      `
      const [statusEvent] = await sql`
        SELECT task_id FROM hub_task_status_event WHERE id = ${STATUS_EVENT_ID}
      `
      const [note] = await sql`
        SELECT promoted_task_id FROM hub_note WHERE id = ${NOTE_ID}
      `
      expect(task?.parent_id).toBe(PARENT_ID)
      expect(comment?.task_id).toBe(TASK_ID)
      expect(document?.task_id).toBe(TASK_ID)
      expect(statusEvent?.task_id).toBe(TASK_ID)
      expect(note?.promoted_task_id).toBe(TASK_ID)

      const unforced = await sql`
        SELECT relname
        FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN (
            'hub_task', 'hub_task_comment', 'hub_task_document', 'hub_task_status_event', 'hub_note'
          )
          AND NOT relforcerowsecurity
        ORDER BY relname
      `
      expect(unforced).toEqual([])
    } finally {
      await sql.close()
    }
  })
})
