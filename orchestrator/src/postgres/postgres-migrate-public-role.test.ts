import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { RECORD_ACTOR_ROLE, RECORD_PUBLIC_ROLE } from '../../../shared/record/schema.ts'
import { migratePostgres } from './postgres-migrate.ts'

const migrationUrl = process.env.ORCH_TEST_PUBLIC_ROLE_MIGRATION_URL
const superuserUrl = process.env.ORCH_TEST_PUBLIC_ROLE_MIGRATION_SUPERUSER_URL
const realPostgres = migrationUrl && superuserUrl ? describe : describe.skip

realPostgres('record public role migration preconditions', () => {
  test('refuses BYPASSRLS and inherited actor membership', async () => {
    const admin = new SQL(superuserUrl!)
    try {
      await admin.unsafe(`ALTER ROLE ${RECORD_PUBLIC_ROLE} BYPASSRLS`)
      await expect(migratePostgres(migrationUrl)).rejects.toThrow(
        'record_public to have NOBYPASSRLS',
      )

      await admin.unsafe(`ALTER ROLE ${RECORD_PUBLIC_ROLE} NOBYPASSRLS`)
      await admin.unsafe(
        `GRANT ${RECORD_PUBLIC_ROLE} TO ${RECORD_ACTOR_ROLE} WITH INHERIT TRUE, SET TRUE`,
      )
      await expect(migratePostgres(migrationUrl)).rejects.toThrow(
        'record_actor membership in record_public with INHERIT FALSE and SET TRUE',
      )
    } finally {
      await admin.unsafe(`ALTER ROLE ${RECORD_PUBLIC_ROLE} NOBYPASSRLS`)
      await admin.unsafe(
        `GRANT ${RECORD_PUBLIC_ROLE} TO ${RECORD_ACTOR_ROLE} WITH INHERIT FALSE, SET TRUE`,
      )
      await admin.close()
    }
  })
})
