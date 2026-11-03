import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { migrationSessionStatements } from '../../../shared/record/migration-session.ts'

const migrationUrl = process.env.BOTTEGA_TEST_CONFIG_ACCESS_MIGRATION_URL
const realPostgres = migrationUrl ? describe : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')
const backfillMigration = '20261103185537_dev_2093_config_access_backfill'
const spaceId = '01990000-0000-7000-8000-000000002093'
const ownerId = '01990000-0000-7000-8000-000000002094'
const memberId = '01990000-0000-7000-8000-000000002095'
let priorToBackfill = ''

realPostgres('config access owner backfill', () => {
  beforeAll(async () => {
    priorToBackfill = mkdtempSync(join(tmpdir(), 'dev-2093-prior-backfill-'))
    for (const folder of readdirSync(migrationsFolder).filter((name) => name < backfillMigration)) {
      cpSync(join(migrationsFolder, folder), join(priorToBackfill, folder), { recursive: true })
    }
    const sql = new SQL({ url: migrationUrl!, max: 1 })
    try {
      for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorToBackfill })
      await sql.unsafe(`
        ALTER TABLE space NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE "user" NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE membership NO FORCE ROW LEVEL SECURITY;
        INSERT INTO space (id, name, slug, created_at)
        VALUES ('${spaceId}', 'DEV-2093 migration proof', 'dev-2093-migration-proof', now());
        INSERT INTO "user" (id, email, name, created_at) VALUES
          ('${ownerId}', 'dev-2093-owner@example.test', 'Owner', now()),
          ('${memberId}', 'dev-2093-member@example.test', 'Member', now());
        INSERT INTO membership (id, space_id, user_id, role, permission, config_access, created_at) VALUES
          ('01990000-0000-7000-8000-000000002096', '${spaceId}', '${ownerId}', 'owner', 'write', false, now()),
          ('01990000-0000-7000-8000-000000002097', '${spaceId}', '${memberId}', 'member', 'write', false, now());
        ALTER TABLE membership FORCE ROW LEVEL SECURITY;
        ALTER TABLE "user" FORCE ROW LEVEL SECURITY;
        ALTER TABLE space FORCE ROW LEVEL SECURITY;
      `)
    } finally {
      await sql.close()
    }
  })

  afterAll(() => rmSync(priorToBackfill, { recursive: true, force: true }))

  test('grants config access to existing owners and leaves non-owners without it', async () => {
    const sql = new SQL({ url: migrationUrl!, max: 1 })
    try {
      for (const statement of migrationSessionStatements()) await sql.unsafe(statement)
      await migrate(drizzle({ client: sql }), { migrationsFolder })
      await sql.unsafe('ALTER TABLE membership NO FORCE ROW LEVEL SECURITY')
      const rows = await sql`
        SELECT role, config_access FROM membership
        WHERE space_id=${spaceId}::uuid ORDER BY role
      `
      await sql.unsafe('ALTER TABLE membership FORCE ROW LEVEL SECURITY')
      expect([...rows]).toEqual([
        { role: 'member', config_access: false },
        { role: 'owner', config_access: true },
      ])
    } finally {
      await sql.close()
    }
  })
})
