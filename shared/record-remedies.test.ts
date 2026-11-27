import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import { RECORD_DOCTOR_REMEDY, recordUnreachableRefusal } from './record-remedies.ts'

test('the record doctor command clears an unclassified hosted response failure', () => {
  expect(RECORD_DOCTOR_REMEDY).toBe(`cleared by: ${PLATFORM_SLUG} record doctor`)
})

test('hosted-record unreachable refusal names the origin, outcome, and doctor remedy', () => {
  for (const [outcome, statement] of [
    ['probe', 'nothing was written'],
    ['idempotent', 'safe to retry'],
    ['non-idempotent', 'the write may have been applied; check before retrying'],
  ] as const) {
    const refusal = recordUnreachableRefusal(
      'https://record.example.test',
      'connection refused',
      outcome,
    )

    expect(refusal).toContain(
      'the hosted record at https://record.example.test could not be reached',
    )
    expect(refusal).toContain('connection refused')
    expect(refusal).toContain(statement)
    expect(refusal).toContain(`cleared by: ${PLATFORM_SLUG} record doctor`)
  }
})
