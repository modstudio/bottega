import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId, PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { migration, postgresSchema } from '../../test/fixtures/postgres-rls.ts'

const OPERATOR_USER_ID = '01990000-0000-7000-8000-000000000002'

describe('Postgres substrate shape', () => {
  test('uses application-minted UUIDv7 ids and declares no id default', () => {
    const generated = newRecordId()
    expect(generated[14]).toBe('7')
    expect(['8', '9', 'a', 'b']).toContain(generated[19]!.toLowerCase())
    expect(migration).not.toMatch(/"id" uuid DEFAULT/i)
  })

  test('seeds the fixed platform space and stand-in operator', () => {
    expect(migration).toContain(
      `VALUES ('${PLATFORM_SPACE_ID}', '${PLATFORM_SLUG}', '2026-09-09T00:00:00Z')`,
    )
    expect(migration).toContain(`'${OPERATOR_USER_ID}'`)
    expect(migration).toContain(`'operator@${PLATFORM_SLUG}.local'`)
    expect(migration.match(/^INSERT INTO /gm)).toHaveLength(3)
  })

  test('tenanted tables force RLS and keep read and write policies separate', () => {
    for (const table of [
      'space',
      'membership',
      'project',
      'run',
      'review',
      'review_lens',
      'review_finding',
      'landing',
      'landing_override',
      'landing_review_carry',
      'contention',
      'test_flake',
      'seq',
      'invitation',
      'hub_day',
      'hub_interval',
      'orch_snapshot',
    ]) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`)
      expect(migration).toContain(`CREATE POLICY "${table}_space_select"`)
      expect(migration).toContain(`CREATE POLICY "${table}_space_insert"`)
      expect(migration).toContain(`CREATE POLICY "${table}_space_update"`)
      expect(migration).toContain(`CREATE POLICY "${table}_space_delete"`)
    }
  })

  test('every schema-first RLS table is forced in migrations', () => {
    const enabled = new Set(
      [...migration.matchAll(/ALTER TABLE "([^"]+)" ENABLE ROW LEVEL SECURITY/g)].map(
        (match) => match[1],
      ),
    )
    const forced = new Set(
      [...migration.matchAll(/ALTER TABLE "([^"]+)" FORCE ROW LEVEL SECURITY/g)].map(
        (match) => match[1],
      ),
    )
    const withRls = new Set(
      [...postgresSchema.matchAll(/pgTable\.withRLS\(\s*['"]([^'"]+)['"]/g)].map(
        (match) => match[1],
      ),
    )
    const dropped = new Set(
      [...migration.matchAll(/DROP TABLE "([^"]+)"/g)].map((match) => match[1]),
    )
    for (const table of dropped) {
      enabled.delete(table)
      forced.delete(table)
      expect(withRls.has(table)).toBe(false)
    }

    expect([...enabled].sort()).toEqual([...forced].sort())
    expect([...withRls].sort()).toEqual([...forced].sort())
  })

  test('machine belongs to a user and seq has the fully qualified key', () => {
    const machineDdl = migration.match(/CREATE TABLE "machine" \([\s\S]*?\n\);/)?.[0]
    expect(machineDdl).toContain('"user_id" uuid NOT NULL')
    expect(machineDdl).not.toContain('"space_id"')
    expect(migration).toContain('PRIMARY KEY("space_id","project_id","name")')
  })
})
