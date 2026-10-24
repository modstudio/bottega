import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { resolveProbeArtifact, resolveProbeIdentifier } from './probe-identifier.ts'

test('resolves a probe number or UUID to the probe UUID', () => {
  const d = migratedTestDatabase()
  try {
    const recordId = '01990000-0000-7000-8000-000000001708'
    d.query(
      `INSERT INTO probe(record_id,command,cwd,exit_code,output_tail,created_at)
       VALUES (?, '[]', '/cwd', 0, '', 'at')`,
    ).run(recordId)
    const number = d
      .query<{ number: number }, [string]>('SELECT number FROM probe WHERE record_id=?')
      .get(recordId)!.number

    expect(resolveProbeIdentifier(d, number)).toBe(recordId)
    expect(resolveProbeIdentifier(d, String(number))).toBe(recordId)
    expect(resolveProbeIdentifier(d, recordId.toUpperCase())).toBe(recordId)
    expect(resolveProbeArtifact(d, `exec:${number}`)).toBe(`exec:${recordId}`)
    expect(resolveProbeArtifact(d, `probe:${recordId.toUpperCase()}`)).toBe(`probe:${recordId}`)
    expect(resolveProbeArtifact(d, 'task:DEV-1708')).toBe('task:DEV-1708')
  } finally {
    d.close()
  }
})

test('refuses malformed and unknown probe identifiers with the accepted forms', () => {
  const d = migratedTestDatabase()
  try {
    expect(() => resolveProbeIdentifier(d, 'abc')).toThrow(
      'expected a positive decimal probe number or a full probe UUID',
    )
    expect(() => resolveProbeIdentifier(d, 404)).toThrow(
      'pass a positive decimal probe number or a full probe UUID',
    )
  } finally {
    d.close()
  }
})
