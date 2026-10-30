import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { DelegationSettings } from '../../../shared/delegation-mode.ts'
import { harnessDelegationRefusal, noEligibleAgentRefusal } from './delegation.ts'

const settings: DelegationSettings = {
  'delegation.implement': 'harness',
  'delegation.review': 'external',
}

test('a harness class refuses external dispatch with its setting and exact switch command', () => {
  expect(harnessDelegationRefusal({ needs: { writesRepo: true } }, settings)).toBe(
    `this machine runs implement work through the harness's own sub-agent (delegation.implement=harness)\n` +
      `cleared by: ${PLATFORM_SLUG} machine config set --machine delegation.implement external`,
  )
  expect(harnessDelegationRefusal({ needs: { readsRepo: true } }, settings)).toBeNull()
})

test('an empty external lane names agent setup and the shared harness remedy', () => {
  expect(
    noEligibleAgentRefusal({
      jobName: 'understand',
      capabilities: {},
      excluded: [],
      undeclaredAgents: [],
    }),
  ).toContain(`${PLATFORM_SLUG} machine config set --machine delegation.review harness`)
})

test('a read-only undeclared job names declaration and read-only harness remedies', () => {
  const refusal = noEligibleAgentRefusal({
    jobName: 'diagnose',
    capabilities: {},
    excluded: ['codex: not declared for diagnose'],
    undeclaredAgents: ['codex'],
  })

  expect(refusal).toContain(
    `${PLATFORM_SLUG} agent set <agent> --jobs <current jobs and diagnose, comma-separated>, then ${PLATFORM_SLUG} agent probe <agent> if its last probe did not cover diagnose`,
  )
  expect(refusal).toContain('switch read-only jobs (all jobs that do not write the repository)')
})
