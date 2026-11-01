import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { migrationSessionStatements } from '../../../shared/record/migration-session.ts'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'

const migrationUrl = process.env.BOTTEGA_TEST_RUN_TASK_REFERENCE_MIGRATION_URL
const realPostgres = migrationUrl ? describe : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')
const expandMigration = '20261026064429_dev_1771_run_task_reference'
const platformOperatorId = '01990000-0000-7000-8000-000000000002'
const otherSpaceId = '01990000-0000-7000-8000-000000001790'
const machineId = '01990000-0000-7000-8000-000000001791'
const ownTaskId = '01990000-0000-7000-8000-000000001792'
const otherOnlyTaskId = '01990000-0000-7000-8000-000000001793'
const platformSharedTaskId = '01990000-0000-7000-8000-000000001794'
const otherSharedTaskId = '01990000-0000-7000-8000-000000001795'
const ownRunId = '01990000-0000-7000-8000-000000001796'
const otherOnlyRunId = '01990000-0000-7000-8000-000000001797'
const platformSharedRunId = '01990000-0000-7000-8000-000000001798'
const otherSharedRunId = '01990000-0000-7000-8000-000000001799'
const keylessRunId = '01990000-0000-7000-8000-000000001800'
const unmatchedRunId = '01990000-0000-7000-8000-000000001801'
let priorToExpand = ''

function copyMigrations(destination: string, keep: (name: string) => boolean): void {
  for (const folder of readdirSync(migrationsFolder).filter(keep)) {
    cpSync(join(migrationsFolder, folder), join(destination, folder), { recursive: true })
  }
}

realPostgres('populated run task_id expand and backfill', () => {
  beforeAll(async () => {
    priorToExpand = mkdtempSync(join(tmpdir(), 'dev-1771-prior-expand-'))
    copyMigrations(priorToExpand, (name) => name < expandMigration)

    const sql = new SQL(migrationUrl!)
    try {
      for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorToExpand })
      await sql.unsafe(`
        ALTER TABLE space NO FORCE ROW LEVEL SECURITY;
        INSERT INTO space (id, name, slug, created_at) VALUES
          ('${otherSpaceId}', 'DEV-1771 migration proof', 'dev-1771-migration-proof', now());
        ALTER TABLE space FORCE ROW LEVEL SECURITY;
        INSERT INTO machine (id, user_id, name, registered_at, last_seen) VALUES
          ('${machineId}', '${platformOperatorId}', 'dev-1771-migration-proof', now(), now());
        ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
        INSERT INTO hub_task
          (id, space_id, project_name, key, project, source, first_seen, last_seen, created_at, updated_at)
        VALUES
          ('${ownTaskId}', '${PLATFORM_SPACE_ID}', 'dev-1771', 'OWN-1', 'dev-1771', 'local', now(), now(), now(), now()),
          ('${otherOnlyTaskId}', '${otherSpaceId}', 'dev-1771', 'OTHER-1', 'dev-1771', 'local', now(), now(), now(), now()),
          ('${platformSharedTaskId}', '${PLATFORM_SPACE_ID}', 'dev-1771', 'SHARED-1', 'dev-1771', 'local', now(), now(), now(), now()),
          ('${otherSharedTaskId}', '${otherSpaceId}', 'dev-1771', 'SHARED-1', 'dev-1771', 'local', now(), now(), now(), now());
        ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;
        ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;
        INSERT INTO "run"
          (id, space_id, machine_id, started_at, agent, job, prompt_sha, prompt_bytes, prompt_head,
           task_key, probe, status, turn, no_failover, automatic_failover, work_preserved, created_at, updated_at)
        VALUES
          ('${ownRunId}', '${PLATFORM_SPACE_ID}', '${machineId}', now(), 'proof', 'proof', 'prompt', 6, 'prompt', 'OWN-1', false, 'ok', 1, false, false, false, now(), now()),
          ('${otherOnlyRunId}', '${PLATFORM_SPACE_ID}', '${machineId}', now(), 'proof', 'proof', 'prompt', 6, 'prompt', 'OTHER-1', false, 'ok', 1, false, false, false, now(), now()),
          ('${platformSharedRunId}', '${PLATFORM_SPACE_ID}', '${machineId}', now(), 'proof', 'proof', 'prompt', 6, 'prompt', 'SHARED-1', false, 'ok', 1, false, false, false, now(), now()),
          ('${otherSharedRunId}', '${otherSpaceId}', '${machineId}', now(), 'proof', 'proof', 'prompt', 6, 'prompt', 'SHARED-1', false, 'ok', 1, false, false, false, now(), now()),
          ('${keylessRunId}', '${PLATFORM_SPACE_ID}', '${machineId}', now(), 'proof', 'proof', 'prompt', 6, 'prompt', NULL, false, 'ok', 1, false, false, false, now(), now()),
          ('${unmatchedRunId}', '${PLATFORM_SPACE_ID}', '${machineId}', now(), 'proof', 'proof', 'prompt', 6, 'prompt', 'MISSING-1', false, 'ok', 1, false, false, false, now(), now());
        ALTER TABLE "run" FORCE ROW LEVEL SECURITY;
      `)
    } finally {
      await sql.close()
    }
  })

  afterAll(() => {
    rmSync(priorToExpand, { recursive: true, force: true })
  })

  test('backfill links only the task with the same key in the same space', async () => {
    const sql = new SQL(migrationUrl!)
    try {
      for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
      await migrate(drizzle({ client: sql }), { migrationsFolder })
      await sql.unsafe('ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY')
      const rows = await sql`
        SELECT id::text AS id, task_id::text AS task_id FROM "run"
        WHERE id IN (
          ${ownRunId}::uuid, ${otherOnlyRunId}::uuid, ${platformSharedRunId}::uuid,
          ${otherSharedRunId}::uuid, ${keylessRunId}::uuid, ${unmatchedRunId}::uuid
        )
        ORDER BY id
      `
      await sql.unsafe('ALTER TABLE "run" FORCE ROW LEVEL SECURITY')
      expect([...rows]).toEqual([
        { id: ownRunId, task_id: ownTaskId },
        { id: otherOnlyRunId, task_id: null },
        { id: platformSharedRunId, task_id: platformSharedTaskId },
        { id: otherSharedRunId, task_id: otherSharedTaskId },
        { id: keylessRunId, task_id: null },
        { id: unmatchedRunId, task_id: null },
      ])

      const unforced = await sql`
        SELECT relname FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN ('run', 'hub_task')
          AND NOT relforcerowsecurity
        ORDER BY relname
      `
      expect(unforced).toEqual([])
    } finally {
      await sql.close()
    }
  })
})
