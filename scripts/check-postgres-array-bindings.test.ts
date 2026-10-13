import { expect, test } from 'bun:test'
import { postgresBindingViolations } from './check-postgres-array-bindings.ts'

test('refuses a serialized value bound directly to jsonb', () => {
  const fixture = String.raw`await tx\`INSERT INTO sample(payload) VALUES (\${JSON.stringify(values)}::jsonb)\``
  expect(postgresBindingViolations(fixture, 'fixture.ts')).toEqual(['fixture.ts:1:jsonb'])
})

test('allows the shared structured jsonb binder', () => {
  const fixture = String.raw`await tx\`INSERT INTO sample(payload) VALUES (\${bindJsonb(tx, values)})\``
  expect(postgresBindingViolations(fixture, 'fixture.ts')).toEqual([])
})
