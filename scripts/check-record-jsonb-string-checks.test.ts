import { expect, test } from 'bun:test'
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
    'run.outside_worktree_writes: NEVER_VALIDATED_JSONB_CHECKS entry is not a hosted jsonb column',
  ])
})
