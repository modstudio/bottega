import { expect, test } from 'bun:test'
import {
  jsonbColumns,
  jsonbStringCheckName,
  missingJsonbStringChecks,
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
  const migration = `ALTER TABLE \"sample\" ADD CONSTRAINT \"${name}\" CHECK (jsonb_typeof(\"stored_payload\") <> 'string') NOT VALID;`
  expect(missingJsonbStringChecks([{ file: 'fixture.ts', source: schema }], migration)).toEqual([])
})
