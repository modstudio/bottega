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

test('reports the offending interpolation line instead of an earlier interpolation', () => {
  const fixture = String.raw`await tx\`INSERT INTO sample(id, payload) VALUES (
    \${id},
    \${payload}::jsonb
  )\``
  expect(postgresBindingViolations(fixture, 'fixture.ts')).toEqual(['fixture.ts:3:jsonb'])
})

test('allows jsonpath casts', () => {
  const fixture = String.raw`await tx\`SELECT \${path}::jsonpath\``
  expect(postgresBindingViolations(fixture, 'fixture.ts')).toEqual([])
})

test('refuses serializer interpolations regardless of the surrounding SQL expression', () => {
  const fixture = String.raw`await tx\`INSERT INTO sample(payload) VALUES (
    (\${JSON.stringify(parenthesized)})::jsonb,
    coalesce(\${canonicalJson(value)}, \${fallback})::jsonb
  )\``
  expect(postgresBindingViolations(fixture, 'fixture.ts')).toEqual([
    'fixture.ts:2:jsonb',
    'fixture.ts:3:jsonb',
  ])
})

test('refuses direct jsonb casts after interpolations with nested brace groups', () => {
  const fixture = String.raw`await tx\`INSERT INTO sample(payload) VALUES (
    \${readJson({ id, payload })}::jsonb,
    coalesce(\${pick({ a: 1 })}::jsonb, payload)
  )\``
  expect(postgresBindingViolations(fixture, 'fixture.ts')).toEqual([
    'fixture.ts:2:jsonb',
    'fixture.ts:3:jsonb',
  ])
})

test('exempts only named JSON-as-text serializer interpolations in their owning file', () => {
  const fixture = String.raw`await tx\`UPDATE port_ref_source SET commits=\${JSON.stringify(source.commits)}\``
  expect(
    postgresBindingViolations(fixture, 'orchestrator/src/record/record-port-catalogue.ts'),
  ).toEqual([])
  expect(postgresBindingViolations(fixture, 'another-file.ts')).toEqual(['another-file.ts:1:jsonb'])
  const differentSerializer = String.raw`await tx\`UPDATE port_ref_source SET commits=\${JSON.stringify(source.other)}\``
  expect(
    postgresBindingViolations(
      differentSerializer,
      'orchestrator/src/record/record-port-catalogue.ts',
    ),
  ).toEqual(['orchestrator/src/record/record-port-catalogue.ts:1:jsonb'])
})

test('allows the shared structured jsonb binder', () => {
  const fixture = String.raw`await tx\`INSERT INTO sample(payload) VALUES (\${bindJsonb(tx, values)})\``
  expect(postgresBindingViolations(fixture, 'fixture.ts')).toEqual([])
})
