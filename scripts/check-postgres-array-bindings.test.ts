import { expect, test } from 'bun:test'
import { postgresBindingViolations } from './check-postgres-array-bindings.ts'

test('refuses values bound directly to json or jsonb', () => {
  const fixture = String.raw`await tx\`INSERT INTO sample(payload) VALUES (\${JSON.stringify(
    values,
  )}::jsonb, \${canonicalJson(other)}::json)\``
  expect(postgresBindingViolations(fixture, 'fixture.ts')).toEqual([
    'fixture.ts:1:jsonb',
    'fixture.ts:3:jsonb',
  ])
})

test('allows the shared structured jsonb binder', () => {
  const fixture = String.raw`await tx\`INSERT INTO sample(payload) VALUES (\${bindJsonb(tx, values)})\``
  expect(postgresBindingViolations(fixture, 'fixture.ts')).toEqual([])
})
