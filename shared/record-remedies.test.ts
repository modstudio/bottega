import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import { recordUnreachableRefusal } from './record-remedies.ts'

test.each([
  ['probe', 'nothing was written'],
  ['idempotent', 'safe to retry'],
  ['non-idempotent', 'the write may have been applied; check before retrying'],
] as const)(
  'hosted-record unreachable refusal names the origin, %s outcome, and doctor remedy',
  (outcome, statement) => {
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
  },
)
