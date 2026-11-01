import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { migrationSessionStatements } from '../../../shared/record/migration-session.ts'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'

const migrationUrl = process.env.BOTTEGA_TEST_RUN_OWNER_MIGRATION_URL
const realPostgres = migrationUrl ? describe : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')
const backfillMigration = '20261026134135_dev_1774_run_owner_backfill'
const machineId = '01990000-0000-7000-8000-000000001810'
const machineUserId = '01990000-0000-7000-8000-000000001811'
const existingOwnerId = '01990000-0000-7000-8000-000000001812'
const ownerlessRunId = '01990000-0000-7000-8000-000000001813'
const ownedRunId = '01990000-0000-7000-8000-000000001814'
let priorToBackfill = ''

realPostgres('populated run owner backfill and contract', () => {
  beforeAll(async () => {
    priorToBackfill = mkdtempSync(join(tmpdir(), 'dev-1774-prior-backfill-'))
    for (const folder of readdirSync(migrationsFolder).filter((name) => name < backfillMigration)) {
      cpSync(join(migrationsFolder, folder), join(priorToBackfill, folder), { recursive: true })
    }
    const sql = new SQL(migrationUrl!)
    try {
      for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorToBackfill })
      await sql.unsafe(`
        INSERT INTO "user" (id, email, name, created_at) VALUES
          ('${machineUserId}', 'dev-1774-machine@example.test', 'Machine user', now()),
          ('${existingOwnerId}', 'dev-1774-owner@example.test', 'Existing owner', now());
        INSERT INTO machine (id, user_id, name, registered_at, last_seen)
        VALUES ('${machineId}', '${machineUserId}', 'dev-1774-proof', now(), now());
        ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;
        INSERT INTO "run"
          (id, space_id, machine_id, started_by_user_id, started_at, agent, job, prompt_sha,
           prompt_bytes, prompt_head, probe, status, turn, no_failover, automatic_failover,
           work_preserved, created_at, updated_at)
        VALUES
          ('${ownerlessRunId}', '${PLATFORM_SPACE_ID}', '${machineId}', NULL, now(), 'proof',
           'proof', 'prompt', 6, 'prompt', false, 'ok', 1, false, false, false, now(), now()),
          ('${ownedRunId}', '${PLATFORM_SPACE_ID}', '${machineId}', '${existingOwnerId}', now(),
           'proof', 'proof', 'prompt', 6, 'prompt', false, 'ok', 1, false, false, false, now(), now());
        ALTER TABLE "run" FORCE ROW LEVEL SECURITY;
      `)
    } finally {
      await sql.close()
    }
  })

  afterAll(() => rmSync(priorToBackfill, { recursive: true, force: true }))

  test('fills missing owners, preserves owners, contracts the column, and restores FORCE RLS', async () => {
    const sql = new SQL(migrationUrl!)
    try {
      for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
      await migrate(drizzle({ client: sql }), { migrationsFolder })
      await sql.unsafe('ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY')
      const rows = await sql`
        SELECT id::text AS id, started_by_user_id::text AS started_by_user_id
        FROM "run" WHERE id IN (${ownerlessRunId}::uuid, ${ownedRunId}::uuid) ORDER BY id
      `
      await sql.unsafe('ALTER TABLE "run" FORCE ROW LEVEL SECURITY')
      expect([...rows]).toEqual([
        { id: ownerlessRunId, started_by_user_id: machineUserId },
        { id: ownedRunId, started_by_user_id: existingOwnerId },
      ])
      const columns = await sql`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='run' AND column_name='started_by_user_id'
      `
      expect([...columns]).toEqual([{ is_nullable: 'NO' }])
      const force = await sql`
        SELECT relforcerowsecurity FROM pg_class
        WHERE relnamespace='public'::regnamespace AND relname='run'
      `
      expect([...force]).toEqual([{ relforcerowsecurity: true }])
    } finally {
      await sql.close()
    }
  })
})
