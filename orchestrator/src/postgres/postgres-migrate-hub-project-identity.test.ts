import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'

const migrationUrl = process.env.BOTTEGA_TEST_HUB_PROJECT_IDENTITY_MIGRATION_URL
const realPostgres = migrationUrl ? describe : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')
const expandMigration = '20261015133608_dev_1214_hub_project_identity'
const backfillMigration = '20261015133609_dev_1214_hub_project_identity_backfill'
const platformOperatorId = '01990000-0000-7000-8000-000000000002'
const matchProjectId = '01990000-0000-7000-8000-000000001214'
const matchTaskId = '01990000-0000-7000-8000-000000001215'
const unmatchedTaskId = '01990000-0000-7000-8000-000000001216'
let priorToExpand = ''
let throughExpand = ''

function copyMigrations(destination: string, keep: (name: string) => boolean): void {
  for (const folder of readdirSync(migrationsFolder).filter(keep)) {
    cpSync(join(migrationsFolder, folder), join(destination, folder), { recursive: true })
  }
}

async function taskProjectIds(sql: SQL): Promise<{ id: string; project_id: string | null }[]> {
  await sql.unsafe('ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY')
  const rows = await sql`
    SELECT id::text AS id, project_id::text AS project_id FROM hub_task
    WHERE id IN (${matchTaskId}::uuid, ${unmatchedTaskId}::uuid)
    ORDER BY key
  `
  await sql.unsafe('ALTER TABLE hub_task FORCE ROW LEVEL SECURITY')
  return rows as { id: string; project_id: string | null }[]
}

realPostgres('populated hub project_id expand and backfill', () => {
  beforeAll(async () => {
    priorToExpand = mkdtempSync(join(tmpdir(), 'dev-1214-prior-expand-'))
    throughExpand = mkdtempSync(join(tmpdir(), 'dev-1214-through-expand-'))
    copyMigrations(priorToExpand, (name) => name < expandMigration)
    copyMigrations(throughExpand, (name) => name < backfillMigration)

    const sql = new SQL(migrationUrl!)
    try {
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorToExpand })
      await sql.unsafe(`
        SELECT set_config('app.space_id', '${PLATFORM_SPACE_ID}', true);
        SELECT set_config('app.user_id', '${platformOperatorId}', true);
        INSERT INTO project (id, space_id, name, created_at) VALUES
          ('${matchProjectId}', '${PLATFORM_SPACE_ID}', 'hub-project-id-match', now());
        ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
        INSERT INTO hub_task
          (id, space_id, project_name, key, project, source, first_seen, last_seen, created_at, updated_at)
        VALUES
          ('${matchTaskId}', '${PLATFORM_SPACE_ID}', 'hub-project-id-match', 'HUB-1',
           'hub-project-id-match', 'git', now(), now(), now(), now()),
          ('${unmatchedTaskId}', '${PLATFORM_SPACE_ID}', 'hub-project-id-unmatched', 'HUB-2',
           'hub-project-id-unmatched', 'git', now(), now(), now(), now());
        ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;
        SELECT set_config('app.space_id', '', true);
        SELECT set_config('app.user_id', '', true);
      `)
      await migrate(drizzle({ client: sql }), { migrationsFolder: throughExpand })
    } finally {
      await sql.close()
    }
  })

  afterAll(() => {
    rmSync(priorToExpand, { recursive: true, force: true })
    rmSync(throughExpand, { recursive: true, force: true })
  })

  test('expand leaves project_id null and backfill fills a unique match', async () => {
    const sql = new SQL(migrationUrl!)
    try {
      expect(await taskProjectIds(sql)).toEqual([
        { id: matchTaskId, project_id: null },
        { id: unmatchedTaskId, project_id: null },
      ])

      await migrate(drizzle({ client: sql }), { migrationsFolder })

      expect(await taskProjectIds(sql)).toEqual([
        { id: matchTaskId, project_id: matchProjectId },
        { id: unmatchedTaskId, project_id: null },
      ])

      const unforced = await sql`
        SELECT relname
        FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN (
            'hub_interval', 'hub_note', 'hub_note_acknowledgement', 'hub_report_subscription',
            'hub_task', 'hub_task_comment', 'hub_task_document', 'hub_task_status_event', 'project'
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
