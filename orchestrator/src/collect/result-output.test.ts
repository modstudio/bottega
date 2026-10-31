import { expect, test } from 'bun:test'
import { observedTestsLine } from './result-output.ts'

test('shows observed tests and their disagreement independently of a reply', () => {
  expect(observedTestsLine({ ran: 0, passed: null, claimDisagrees: 1 })).toBe(
    'tests observed: {"ran":false,"passed":null}; tests_claim_disagrees: true',
  )
})

test('shows an unavailable runner as unobserved and non-disagreeing', () => {
  expect(observedTestsLine({ ran: null, passed: null, claimDisagrees: 0 })).toBe(
    'tests observed: not observed; tests_claim_disagrees: false',
  )
  expect(observedTestsLine({ ran: null, passed: null, claimDisagrees: null })).toBeNull()
})

test('shows an unverified claim beside what was observed', () => {
  expect(observedTestsLine({ ran: 0, passed: null, claimDisagrees: null })).toBe(
    'tests observed: {"ran":false,"passed":null}; tests_claim_disagrees: unverified',
  )
  expect(observedTestsLine({ ran: 1, passed: null, claimDisagrees: null })).toBe(
    'tests observed: {"ran":true,"passed":null}; tests_claim_disagrees: unverified',
  )
})
