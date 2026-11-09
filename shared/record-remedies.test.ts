import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import { recordUnreachableRefusal } from './record-remedies.ts'

test('hosted-record unreachable refusal names the origin, outcome, and doctor remedy', () => {
  const refusal = recordUnreachableRefusal('https://record.example.test', 'connection refused')

  expect(refusal).toContain('the hosted record at https://record.example.test could not be reached')
  expect(refusal).toContain('connection refused')
  expect(refusal).toContain('nothing was written')
  expect(refusal).toContain(`cleared by: ${PLATFORM_SLUG} record doctor`)
})
