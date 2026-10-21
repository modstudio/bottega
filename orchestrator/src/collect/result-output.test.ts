import { expect, test } from 'bun:test'
import { observedTestsLine } from './result-output.ts'

test('shows observed tests and their disagreement independently of a reply', () => {
  expect(observedTestsLine({ ran: 0, passed: null, claimDisagrees: 1 })).toBe(
    'tests observed: {"ran":false,"passed":null}; tests_claim_disagrees: true',
  )
})
