import { describe, expect, test } from 'bun:test'
import { recordDoctorExitCode, redactRecordPasswords, unattributedShare } from './record-doctor.ts'

describe('record doctor decisions', () => {
  test('fails its exit code exactly when a named check fails', () => {
    expect(recordDoctorExitCode([{ name: 'ready', status: 'pass' }])).toBe(0)
    expect(
      recordDoctorExitCode([
        { name: 'optional', status: 'skipped', detail: 'not configured' },
        { name: 'owner', status: 'fail' },
      ]),
    ).toBe(1)
  })

  test('redacts URL passwords from diagnostics', () => {
    const url = 'postgres://record_actor:secret-value@record.example/db'
    expect(redactRecordPasswords(`could not connect to ${url}: secret-value`, [url])).toBe(
      'could not connect to postgres://record_actor:***@record.example/db: ***',
    )
  })

  test('reports unattributed rows rather than presenting a clean estate', () => {
    expect(unattributedShare(3, 4)).toBe('3/4 (75.0%) unattributed')
    expect(unattributedShare(0, 0)).toBe('0/0 (0.0%) unattributed')
  })
})
