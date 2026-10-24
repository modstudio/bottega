import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { resolveGateIdentifier } from './gate-identifier.ts'

test('resolves a gate number or UUID to the gate UUID', () => {
  const d = migratedTestDatabase()
  try {
    const recordId = '01990000-0000-7000-8000-000000001699'
    d.query('INSERT INTO gate_execution(record_id,requested_at) VALUES (?,?)').run(recordId, 'at')
    const number = d
      .query<{ number: number }, [string]>('SELECT number FROM gate_execution WHERE record_id=?')
      .get(recordId)!.number

    expect(resolveGateIdentifier(d, number)).toBe(recordId)
    expect(resolveGateIdentifier(d, String(number))).toBe(recordId)
    expect(resolveGateIdentifier(d, recordId.toUpperCase())).toBe(recordId)
  } finally {
    d.close()
  }
})

test('refuses malformed and unknown gate identifiers with the accepted forms', () => {
  const d = migratedTestDatabase()
  try {
    expect(() => resolveGateIdentifier(d, 'abc')).toThrow(
      'expected a positive decimal gate number or a full gate UUID',
    )
    expect(() => resolveGateIdentifier(d, 404)).toThrow(
      'pass a positive decimal gate number or a full gate UUID',
    )
  } finally {
    d.close()
  }
})
