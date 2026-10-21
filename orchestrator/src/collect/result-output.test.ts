import { expect, test } from 'bun:test'
import { withTestClaimDisagreement } from './result-output.ts'

test('shows the observed disagreement beside the unchanged tests claim', () => {
  const shown = JSON.parse(
    withTestClaimDisagreement('{"status":"done","tests":{"ran":true,"passed":true}}', 1)!,
  )
  expect(shown).toEqual({
    status: 'done',
    tests: { ran: true, passed: true },
    tests_claim_disagrees: true,
  })
})
