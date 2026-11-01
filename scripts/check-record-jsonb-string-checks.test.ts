import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import {
  jsonbColumns,
  jsonbStringCheckName,
  jsonbStringValidationFailures,
  missingJsonbStringChecks,
  NEVER_VALIDATED_JSONB_CHECKS,
} from './check-record-jsonb-string-checks.ts'

const schema = `
  export const sample = pgTable('sample', {
    id: uuid().primaryKey(),
    payload: jsonb('stored_payload'),
  })
`

test('fails when a hosted jsonb column lacks its named string-refusing check', () => {
  expect(missingJsonbStringChecks([{ file: 'fixture.ts', source: schema }], '')).toEqual([
    'sample.stored_payload',
  ])
})

test('accepts the named NOT VALID string-refusing check', () => {
  const [column] = jsonbColumns(schema)
  expect(column).toBeDefined()
  const name = jsonbStringCheckName(column!)
  const migration = `ALTER TABLE "sample" ADD CONSTRAINT "${name}" CHECK (jsonb_typeof("stored_payload") <> 'string') NOT VALID;`
  expect(missingJsonbStringChecks([{ file: 'fixture.ts', source: schema }], migration)).toEqual([])
})

test('fails when an ordinary hosted jsonb check is added but not validated', () => {
  const name = jsonbStringCheckName({ table: 'sample', column: 'stored_payload' })
  const migration = `ALTER TABLE "sample" ADD CONSTRAINT "${name}" CHECK (jsonb_typeof("stored_payload") <> 'string') NOT VALID;`
  expect(
    jsonbStringValidationFailures([{ file: 'fixture.ts', source: schema }], migration, []),
  ).toEqual([
    'sample.stored_payload: hosted jsonb columns not in NEVER_VALIDATED_JSONB_CHECKS require a VALIDATE statement',
  ])
})

test('fails when a never-validated hosted jsonb check has a validation statement', () => {
  const column = { table: 'sample', column: 'stored_payload' }
  const migration = `ALTER TABLE "sample" VALIDATE CONSTRAINT "${jsonbStringCheckName(column)}";`
  expect(
    jsonbStringValidationFailures([{ file: 'fixture.ts', source: schema }], migration, [column]),
  ).toEqual([
    'sample.stored_payload: NEVER_VALIDATED_JSONB_CHECKS columns must not have a VALIDATE statement',
  ])
})

test('fails when a never-validated entry is not a hosted jsonb column', () => {
  expect(jsonbStringValidationFailures([], '', NEVER_VALIDATED_JSONB_CHECKS.slice(0, 1))).toEqual([
    'doc_revision.source_files: NEVER_VALIDATED_JSONB_CHECKS entry is not a hosted jsonb column',
  ])
})

test('local and record migrations apply the same outside-worktree NUL rewrite', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const fixture = [
    {
      project: PLATFORM_SLUG,
      path: 'design-light.png',
      before: ' M design-light.png\0',
      after: '?? design-light.png\0',
    },
  ]
  const encodedFixture = JSON.stringify(fixture)

  const local = new Database(':memory:')
  local.exec('CREATE TABLE run (outside_worktree_writes TEXT)')
  local.query('INSERT INTO run (outside_worktree_writes) VALUES (?)').run(encodedFixture)
  const localMigration = await readFile(
    `${root}/orchestrator/migrations/0192_run_outside_worktree_writes_nul.sql`,
    'utf8',
  )
  local.exec(localMigration)
  const localOutput = local.query('SELECT outside_worktree_writes AS value FROM run').get() as {
    value: string
  }
  local.close()

  const record = new PGlite()
  await record.waitReady
  try {
    await record.exec('CREATE TABLE run (outside_worktree_writes jsonb);')
    await record.query('INSERT INTO run (outside_worktree_writes) VALUES ($1::jsonb)', [
      JSON.stringify(encodedFixture),
    ])
    await record.exec(`
      ALTER TABLE run ADD CONSTRAINT run_outside_worktree_writes_not_json_string_check
        CHECK (jsonb_typeof(outside_worktree_writes) <> 'string') NOT VALID;
      ALTER TABLE run ENABLE ROW LEVEL SECURITY;
      ALTER TABLE run FORCE ROW LEVEL SECURITY;
    `)
    const migration = readMigrationFiles({
      migrationsFolder: `${root}/shared/record/migrations`,
    }).find(({ name }) => name === '20261101110225_dev_1901_run_outside_worktree_writes_repair')
    expect(migration).toBeDefined()
    for (const statement of migration!.sql) await record.exec(statement)

    const recordOutput = await record.query<{ value: unknown }>(
      'SELECT outside_worktree_writes AS value FROM run',
    )
    expect(recordOutput.rows).toHaveLength(1)
    expect(recordOutput.rows[0]?.value).toEqual(JSON.parse(localOutput.value))
  } finally {
    await record.close()
  }
})
