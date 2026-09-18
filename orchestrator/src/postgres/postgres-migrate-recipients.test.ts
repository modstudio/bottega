import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'

const migrationUrl = process.env.ORCH_TEST_RECIPIENT_MIGRATION_URL
const realPostgres = migrationUrl ? describe : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')
const recipientMigration = '20260918160359_dev_803_report_recipients'
let priorMigrations = ''

const USER_ID = '01990000-0000-7000-8000-000000008060'
const SUBSCRIPTION_ID = '01990000-0000-7000-8000-000000008061'
const SEND_ID = '01990000-0000-7000-8000-000000008062'

realPostgres('populated report recipient migration', () => {
  beforeAll(async () => {
    priorMigrations = mkdtempSync(join(tmpdir(), 'dev-806-prior-migrations-'))
    for (const folder of readdirSync(migrationsFolder).filter(
      (name) => name < recipientMigration,
    )) {
      cpSync(join(migrationsFolder, folder), join(priorMigrations, folder), { recursive: true })
    }

    const sql = new SQL(migrationUrl!)
    try {
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorMigrations })
      await sql.unsafe(`SET app.space_id = '${PLATFORM_SPACE_ID}'`)
      await sql`
        INSERT INTO "user" (id, email, name, created_at)
        VALUES (${USER_ID}, 'recipient-migration@example.test', 'Migration Recipient', now())
      `
      await sql`
        INSERT INTO hub_report_subscription
          (id, space_id, scope_kind, project_name, person_user_id, cadence, hour, weekday,
           zone, recipient_user_id, enabled, created_at, updated_at)
        VALUES
          (${SUBSCRIPTION_ID}, ${PLATFORM_SPACE_ID}, 'project', ${PLATFORM_SLUG}, NULL, 'daily', 8,
           NULL, 'UTC', ${USER_ID}, 1, now(), now())
      `
      await sql`
        INSERT INTO hub_send
          (id, space_id, at, "window", recipients, projects, items, status, error, test,
           created_at, machine, subscription_id, period_start, period_end)
        VALUES
          (${SEND_ID}, ${PLATFORM_SPACE_ID}, now(), 'daily', 'recipient-migration@example.test',
           ${PLATFORM_SLUG}, 1, 'sent', NULL, 0, now(), 'test-machine', ${SUBSCRIPTION_ID},
           now() - interval '1 day', now())
      `
      await migrate(drizzle({ client: sql }), { migrationsFolder })
    } finally {
      await sql.close()
    }
  })

  afterAll(() => rmSync(priorMigrations, { recursive: true, force: true }))

  test('backfills subscription and send recipients from the prior populated shape', async () => {
    const sql = new SQL(migrationUrl!)
    try {
      await sql.unsafe(`SET app.space_id = '${PLATFORM_SPACE_ID}'`)
      const subscriptionRecipients = await sql`
        SELECT subscription_id, user_id FROM hub_report_subscription_recipient
      `
      expect(subscriptionRecipients).toEqual([
        { subscription_id: SUBSCRIPTION_ID, user_id: USER_ID },
      ])

      const sendRecipients = await sql`
        SELECT send_id, user_id, name, email FROM hub_send_recipient
      `
      expect(sendRecipients).toEqual([
        {
          send_id: SEND_ID,
          user_id: USER_ID,
          name: 'Migration Recipient',
          email: 'recipient-migration@example.test',
        },
      ])
    } finally {
      await sql.close()
    }
  })

  test('leaves every row-level secured table forced', async () => {
    const sql = new SQL(migrationUrl!)
    try {
      const unforced = await sql`
        SELECT relname
        FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relkind = 'r'
          AND relrowsecurity
          AND NOT relforcerowsecurity
        ORDER BY relname
      `
      expect(unforced).toEqual([])
    } finally {
      await sql.close()
    }
  })
})
