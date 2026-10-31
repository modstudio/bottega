import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import {
  parseProbeArtifact,
  resolveProbeArtifact,
  resolveProbeIdentifier,
} from './probe-identifier.ts'

test('parses probe and exec artifact references in one owner', () => {
  expect(parseProbeArtifact('probe:7')).toEqual({
    kind: 'probe',
    identifier: { kind: 'number', number: 7 },
  })
  expect(parseProbeArtifact('exec:01990000-0000-7000-8000-000000001708')).toEqual({
    kind: 'exec',
    identifier: { kind: 'record-id', recordId: '01990000-0000-7000-8000-000000001708' },
  })
  expect(parseProbeArtifact('task:DEV-1708')).toBeUndefined()
})

test('parses current and former machine labels and refuses foreign labels', () => {
  const names = { shortName: 'mine', formerShortNames: ['old-mine'] }
  expect(parseProbeArtifact('probe:mine/7', names)?.identifier).toEqual({
    kind: 'number',
    number: 7,
  })
  expect(parseProbeArtifact('exec:old-mine/8', names)?.identifier).toEqual({
    kind: 'number',
    number: 8,
  })
  expect(() => parseProbeArtifact('probe:other/7', names)).toThrow(
    "acts only on this machine's (`mine`) rows",
  )
  expect(() => parseProbeArtifact('probe:mine/7', null)).toThrow('has no short name')
  expect(() => parseProbeArtifact('probe:Bad/7', names)).toThrow('invalid probe identifier')
})

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
      'expected a positive decimal probe number, name/number, or a full probe UUID',
    )
    expect(() => resolveProbeIdentifier(d, 404)).toThrow(
      'pass a positive decimal probe number, name/number, or a full probe UUID',
    )
  } finally {
    d.close()
  }
})
